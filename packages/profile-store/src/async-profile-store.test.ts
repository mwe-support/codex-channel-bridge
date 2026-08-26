import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NormalizedChannelMessage } from "@codex-channel-bridge/core";

import { ProfileStore } from "./async-profile-store.js";
import { ProfileStoreError } from "./profile-store.js";

function message(overrides: Partial<NormalizedChannelMessage> = {}): NormalizedChannelMessage {
  return {
    profileId: "alpha",
    provider: "qq",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    providerEventId: "event-1",
    conversationKey: "qq:private:conversation-1",
    conversationKind: "private",
    providerIdentity: "participant-1",
    observedAtMs: 1_000,
    text: "worker-thread archive",
    ...overrides
  };
}

async function temporaryDatabase(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-async-store-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  return join(directory, "bridge.sqlite");
}

test("executes archive operations through the asynchronous Profile Store interface", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = await ProfileStore.open({ profileId: "alpha", databasePath });
  assert.equal(await store.journalMode(), "wal");
  const first = await store.commitMessage(message());
  const duplicate = await store.commitMessage(message({ text: "replayed" }));
  assert.equal(first.inserted, true);
  assert.deepEqual(duplicate, { recordId: first.recordId, inserted: false });
  assert.equal((await store.recentMessages("qq:private:conversation-1"))[0]?.text, "worker-thread archive");
  assert.equal((await store.searchText({ text: "worker archive" })).length, 1);
  await store.close();
});

test("preserves typed store failures across the Worker-thread seam", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = await ProfileStore.open({ profileId: "alpha", databasePath });
  await assert.rejects(
    store.commitMessage(message({ profileId: "beta" })),
    (error: unknown) => error instanceof ProfileStoreError && error.reason === "invalid_channel_message"
  );
  await store.close();
});

test("fails closed when the storage Worker cannot open the database", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = await ProfileStore.open({ profileId: "alpha", databasePath });
  await store.close();
  await assert.rejects(
    ProfileStore.open({ profileId: "beta", databasePath }),
    (error: unknown) => error instanceof ProfileStoreError && error.reason === "profile_mismatch"
  );
});
