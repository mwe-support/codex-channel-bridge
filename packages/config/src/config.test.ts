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
    stateDirectory: /srv/alpha/state
  beta:
    enabled: false
    workspace: /srv/beta/workspace
    codexHome: /srv/beta/codex
    stateDirectory: /srv/beta/state
`;

test("parses a complete candidate and applies defaults", () => {
  const candidate = parseConfiguration(baseline);
  assert.equal(candidate.configuration.profiles.alpha?.enabled, true);
  assert.equal(candidate.configuration.profiles.beta?.enabled, false);
  assert.equal(candidate.configuration.profiles.alpha?.secretsFile, "/srv/alpha/state/secrets.env");
  assert.deepEqual(candidate.configuration.profiles.alpha?.channelAccounts, {});
  assert.equal(candidate.configuration.supervisor.drainTimeoutMs, 300_000);
  assert.match(candidate.revision, /^[a-f0-9]{64}$/);
});

test("parses QQ Channel Accounts using Secret References only", () => {
  const candidate = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
    secretsFile: /srv/alpha/private/secrets.env
    channelAccounts:
      qq-primary:
        provider: qq
        epochId: epoch-1
        appId: env:TEST_APP_ID
        appSecret: file:/run/secrets/test-app-secret
`);
  assert.deepEqual(candidate.configuration.profiles.alpha?.channelAccounts["qq-primary"], {
    id: "qq-primary",
    provider: "qq",
    enabled: true,
    epochId: "epoch-1",
    appId: "env:TEST_APP_ID",
    appSecret: "file:/run/secrets/test-app-secret"
  });
});

test("rejects plaintext QQ credentials and duplicate cross-Profile Channel Account IDs", () => {
  assert.throws(
    () =>
      parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
    channelAccounts:
      shared-qq:
        provider: qq
        epochId: epoch-1
        appId: plaintext
        appSecret: env:TEST_SECRET
  beta:
    workspace: /srv/beta/workspace
    codexHome: /srv/beta/codex
    stateDirectory: /srv/beta/state
    channelAccounts:
      shared-qq:
        provider: qq
        epochId: epoch-2
        appId: env:OTHER_APP_ID
        appSecret: env:OTHER_SECRET
`),
    (error: unknown) =>
      error instanceof ConfigurationValidationError &&
      error.issues.some((issue) => issue.includes("Secret Reference")) &&
      error.issues.some((issue) => issue.includes("duplicates Profile"))
  );
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
    stateDirectory: /srv/beta/state
    workspace: /srv/beta/workspace
    enabled: false
  alpha:
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
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
    stateDirectory: /srv/alpha/state
  beta:
    workspace: /srv/shared
    codexHome: /srv/beta/codex
    stateDirectory: /srv/beta/state
`),
    ConfigurationValidationError
  );
});

test("rejects a Bridge state directory that overlaps Codex-owned data", () => {
  assert.throws(
    () =>
      parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/codex/bridge-state
`),
    (error: unknown) =>
      error instanceof ConfigurationValidationError &&
      error.issues.some((issue) => issue.includes("stateDirectory"))
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
    stateDirectory: /srv/alpha/state
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
  const stateDirectory = join(root, "state");
  const path = join(root, "config.yaml");
  await Promise.all([mkdir(workspace), mkdir(codexHome), mkdir(stateDirectory, { mode: 0o700 })]);
  await writeFile(
    path,
    `schemaVersion: 1\nprofiles:\n  alpha:\n    workspace: ${workspace}\n    codexHome: ${codexHome}\n    stateDirectory: ${stateDirectory}\n`,
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
    `schemaVersion: 1\nprofiles:\n  alpha:\n    workspace: ${join(root, "missing")}\n    codexHome: ${join(root, "codex-home")}\n    stateDirectory: ${join(root, "state")}\n`,
    { mode: 0o600 }
  );
  try {
    await assert.rejects(() => loadConfiguration(path, { environment: {} }), ConfigurationValidationError);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
