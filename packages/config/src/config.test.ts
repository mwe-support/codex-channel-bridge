import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigurationValidationError,
  formatConfiguration,
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

test("formats setup input as validated YAML", () => {
  const text = formatConfiguration({
    schemaVersion: 1,
    profiles: {
      alpha: {
        workspace: "/srv/alpha/workspace",
        codexHome: "/srv/alpha/codex",
        stateDirectory: "/srv/alpha/state"
      }
    }
  });
  assert.match(text, /^schemaVersion: 1/m);
  assert.equal(parseConfiguration(text).configuration.profiles.alpha?.workspace, "/srv/alpha/workspace");
});

test("parses a complete candidate and applies defaults", () => {
  const candidate = parseConfiguration(baseline);
  assert.equal(candidate.configuration.profiles.alpha?.enabled, true);
  assert.equal(candidate.configuration.profiles.beta?.enabled, false);
  assert.equal(candidate.configuration.profiles.alpha?.secretsFile, "/srv/alpha/state/secrets.env");
  assert.deepEqual(candidate.configuration.profiles.alpha?.channelAccounts, {});
  assert.equal(candidate.configuration.supervisor.drainTimeoutMs, 300_000);
  assert.equal(candidate.configuration.supervisor.codexRestartCooldownMs, 30_000);
  assert.equal(candidate.configuration.supervisor.diskSafetyFloorBytes, 512 * 1024 * 1024);
  assert.deepEqual(candidate.configuration.profiles.alpha?.approval, {
    timeoutMs: 300_000,
    detail: "minimal"
  });
  assert.deepEqual(candidate.configuration.profiles.alpha?.media, {
    perAttachmentLimitBytes: 64 * 1024 * 1024,
    profileQuotaBytes: 10 * 1024 * 1024 * 1024
  });
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
    appSecret: "file:/run/secrets/test-app-secret",
    groupThreadScope: "conversation",
    accessPolicy: {
      privateChats: { mode: "deny", allow: [] },
      groupChats: { mode: "deny", allow: [] },
      groupParticipants: { mode: "deny", allow: [] }
    }
  });
});

test("parses WhatsApp Channel Accounts without plaintext or Secret Reference fields", () => {
  const candidate = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
    channelAccounts:
      wa-primary:
        provider: whatsapp
        epochId: epoch-1
        groupThreadScope: participant
        accessPolicy:
          privateChats:
            mode: open
          groupChats:
            mode: allowlist
            allow: [120363000000000000@g.us]
          groupParticipants:
            mode: open
`);
  assert.deepEqual(candidate.configuration.profiles.alpha?.channelAccounts["wa-primary"], {
    id: "wa-primary",
    provider: "whatsapp",
    enabled: true,
    epochId: "epoch-1",
    groupThreadScope: "participant",
    accessPolicy: {
      privateChats: { mode: "open", allow: [] },
      groupChats: { mode: "allowlist", allow: ["120363000000000000@g.us"] },
      groupParticipants: { mode: "open", allow: [] }
    }
  });
});

test("parses fail-closed access and bounded admission settings", () => {
  const candidate = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
    admission:
      mode: queue
      maximumActiveTurns: 2
      queueCapacity: 8
      maximumQueueAgeMs: 60000
      accountRateLimit: 5
      accountRateWindowMs: 10000
    approval:
      timeoutMs: 120000
      detail: detailed
    media:
      perAttachmentLimitBytes: 1024
      profileQuotaBytes: 4096
    channelAccounts:
      qq-primary:
        provider: qq
        epochId: epoch-1
        appId: env:TEST_APP_ID
        appSecret: env:TEST_APP_SECRET
        groupThreadScope: participant
        accessPolicy:
          privateChats:
            mode: allowlist
            allow: [private-user]
          groupChats:
            mode: allowlist
            allow: [group-1]
          groupParticipants:
            mode: open
`);
  const profile = candidate.configuration.profiles.alpha!;
  assert.deepEqual(profile.admission, {
    mode: "queue",
    maximumActiveTurns: 2,
    queueCapacity: 8,
    maximumQueueAgeMs: 60_000,
    accountRateLimit: 5,
    accountRateWindowMs: 10_000
  });
  assert.deepEqual(profile.approval, { timeoutMs: 120_000, detail: "detailed" });
  assert.deepEqual(profile.media, {
    perAttachmentLimitBytes: 1_024,
    profileQuotaBytes: 4_096
  });
  assert.equal(profile.channelAccounts["qq-primary"]?.groupThreadScope, "participant");
  assert.deepEqual(profile.channelAccounts["qq-primary"]?.accessPolicy.groupParticipants, {
    mode: "open",
    allow: []
  });
});

test("rejects a Profile media quota smaller than its attachment limit", () => {
  assert.throws(
    () => parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
    media:
      perAttachmentLimitBytes: 4096
      profileQuotaBytes: 1024
`),
    (error: unknown) =>
      error instanceof ConfigurationValidationError &&
      error.issues.includes("profiles.alpha.media.profileQuotaBytes must be at least perAttachmentLimitBytes")
  );
});

test("rejects ambiguous or incomplete access policy", () => {
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
      qq-primary:
        provider: qq
        epochId: epoch-1
        appId: env:TEST_APP_ID
        appSecret: env:TEST_APP_SECRET
        accessPolicy:
          privateChats:
            mode: allowlist
            allow: []
          groupChats:
            mode: open
            allow: [misleading-entry]
`),
    (error: unknown) =>
      error instanceof ConfigurationValidationError &&
      error.issues.some((issue) => issue.includes("must not be empty")) &&
      error.issues.some((issue) => issue.includes("only valid in allowlist"))
  );
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

test("rejects Secret File ownership shared across Profiles", () => {
  assert.throws(
    () => parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
    secretsFile: /srv/shared/secrets.env
  beta:
    workspace: /srv/beta/workspace
    codexHome: /srv/beta/codex
    stateDirectory: /srv/beta/state
    secretsFile: /srv/shared/secrets.env
`),
    (error: unknown) =>
      error instanceof ConfigurationValidationError &&
      error.issues.some((issue) => issue.includes("secretsFile overlaps"))
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
