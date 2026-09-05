import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { secureWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

import type { ProfileConfiguration } from "@codex-channel-bridge/config";
import { SqliteProfileStore } from "@codex-channel-bridge/profile-store";

import { applyProfilePurge, planProfilePurge } from "./profile-purge.js";

async function fixture(context: test.TestContext): Promise<Readonly<ProfileConfiguration>> {
  const root = await mkdtemp(join(tmpdir(), "bridge-profile-purge-"));
  secureWindowsOwnerOnlyPath(root, "directory");
  await chmod(root, 0o700);
  context.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const stateDirectory = join(root, "state");
  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(codexHome, { mode: 0o700 }),
    mkdir(stateDirectory, { mode: 0o700 })
  ]);
  await writeFile(join(workspace, "keep.txt"), "workspace", { mode: 0o600 });
  await writeFile(join(codexHome, "keep.txt"), "codex", { mode: 0o600 });
  await writeFile(join(stateDirectory, "secrets.env"), "TEST=value\n", { mode: 0o600 });
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath: join(stateDirectory, "bridge.sqlite") });
  store.commitMessage({
    profileId: "alpha",
    provider: "qq",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    providerEventId: "event-1",
    conversationKey: "qq:qq-primary:private:user-1",
    conversationKind: "private",
    providerConversationId: "user-1",
    providerIdentity: "user-1",
    observedAtMs: 1,
    text: "purge me"
  });
  store.close();
  return {
    id: "alpha",
    enabled: false,
    workspace,
    codexHome,
    stateDirectory,
    secretsFile: join(stateDirectory, "secrets.env"),
    channelAccounts: {},
    admission: {
      mode: "steer",
      maximumActiveTurns: 1,
      queueCapacity: 1,
      maximumQueueAgeMs: 1_000,
      accountRateLimit: 1,
      accountRateWindowMs: 1_000
    },
    approval: { detail: "summary", timeoutMs: 1_000 },
    media: { perAttachmentLimitBytes: 1_024, profileQuotaBytes: 4_096 }
  };
}

test("purges only disabled Profile-owned paths and retains a body-free tombstone", async (context) => {
  const profile = await fixture(context);
  const preview = await planProfilePurge(profile);
  assert.equal(preview.state.archiveMessages, 1);
  assert.deepEqual(preview.preservedPaths, [profile.workspace, profile.codexHome]);
  const result = await applyProfilePurge({
    profile,
    expectedSelectionDigest: preview.selectionDigest,
    confirmedProfileId: "alpha",
    nowMs: 2_000
  });
  assert.equal(result.profileId, "alpha");
  await assert.rejects(stat(profile.stateDirectory));
  assert.equal(await readFile(join(profile.workspace, "keep.txt"), "utf8"), "workspace");
  assert.equal(await readFile(join(profile.codexHome, "keep.txt"), "utf8"), "codex");
  const tombstone = await readFile(preview.tombstonePath, "utf8");
  assert.match(tombstone, /codex-channel-bridge-profile-tombstone/u);
  assert.match(tombstone, /"result":"succeeded"/u);
  assert.doesNotMatch(tombstone, /purge me|TEST=value|workspace\/keep/u);
  await assert.rejects(planProfilePurge(profile), /already been purged/u);
});

test("does not create a tombstone when purge confirmation is wrong", async (context) => {
  const profile = await fixture(context);
  const preview = await planProfilePurge(profile);
  await assert.rejects(
    applyProfilePurge({
      profile,
      expectedSelectionDigest: preview.selectionDigest,
      confirmedProfileId: "beta",
      nowMs: 2_000
    }),
    /complete Profile ID/u
  );
  assert.equal((await stat(profile.stateDirectory)).isDirectory(), true);
  await assert.rejects(stat(preview.tombstonePath));
});
