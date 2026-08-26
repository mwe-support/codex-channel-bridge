import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigurationValidationError,
  loadConfiguration,
  parseConfiguration
} from "./config.js";

const baseline = `
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
  beta:
    enabled: false
    workspace: /srv/beta/workspace
    codexHome: /srv/beta/codex
`;

test("parses a complete candidate and applies defaults", () => {
  const candidate = parseConfiguration(baseline);
  assert.equal(candidate.configuration.profiles.alpha?.enabled, true);
  assert.equal(candidate.configuration.profiles.beta?.enabled, false);
  assert.equal(candidate.configuration.supervisor.drainTimeoutMs, 300_000);
  assert.match(candidate.revision, /^[a-f0-9]{64}$/);
});

test("environment JSON overrides YAML by Profile ID", () => {
  const candidate = parseConfiguration(
    baseline,
    JSON.stringify({ profiles: { beta: { enabled: true } } })
  );
  assert.equal(candidate.configuration.profiles.beta?.enabled, true);
  assert.equal(candidate.environmentOverrideApplied, true);
});

test("produces the same revision for equivalent key order", () => {
  const first = parseConfiguration(baseline);
  const second = parseConfiguration(`
profiles:
  beta:
    codexHome: /srv/beta/codex
    workspace: /srv/beta/workspace
    enabled: false
  alpha:
    codexHome: /srv/alpha/codex
    workspace: /srv/alpha/workspace
schemaVersion: 1
`);
  assert.equal(first.revision, second.revision);
});

test("rejects unknown fields instead of silently accepting them", () => {
  assert.throws(
    () => parseConfiguration(`${baseline}\ntelemetry: true\n`),
    (error: unknown) => {
      assert(error instanceof ConfigurationValidationError);
      assert(error.issues.includes("config.telemetry is not supported"));
      return true;
    }
  );
});

test("rejects duplicate Workspace ownership", () => {
  assert.throws(
    () =>
      parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/shared
    codexHome: /srv/alpha/codex
  beta:
    workspace: /srv/shared
    codexHome: /srv/beta/codex
`),
    ConfigurationValidationError
  );
});

test("rejects YAML aliases and malformed environment overrides", () => {
  assert.throws(
    () =>
      parseConfiguration(`
schemaVersion: 1
profiles:
  alpha: &profile
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
  beta: *profile
`),
    ConfigurationValidationError
  );
  assert.throws(() => parseConfiguration(baseline, "{"), ConfigurationValidationError);
  assert.throws(
    () => parseConfiguration(baseline, '{"__proto__":{"polluted":true}}'),
    ConfigurationValidationError
  );
});

test("loadConfiguration validates Profile directories without changing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-config-test-"));
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const path = join(root, "config.yaml");
  await Promise.all([mkdir(workspace), mkdir(codexHome)]);
  await writeFile(
    path,
    `schemaVersion: 1\nprofiles:\n  alpha:\n    workspace: ${workspace}\n    codexHome: ${codexHome}\n`,
    { mode: 0o600 }
  );
  try {
    const candidate = await loadConfiguration(path, { environment: {} });
    assert.equal(candidate.configuration.profiles.alpha?.workspace, workspace);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("loadConfiguration fails closed when a configured directory is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-config-test-"));
  const path = join(root, "config.yaml");
  await writeFile(
    path,
    `schemaVersion: 1\nprofiles:\n  alpha:\n    workspace: ${join(root, "missing")}\n    codexHome: ${root}\n`,
    { mode: 0o600 }
  );
  try {
    await assert.rejects(() => loadConfiguration(path, { environment: {} }), ConfigurationValidationError);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
