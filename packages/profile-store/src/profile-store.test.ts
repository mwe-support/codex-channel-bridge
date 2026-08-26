import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import type { NormalizedChannelMessage } from "@codex-channel-bridge/core";

import { ProfileStoreError, SqliteProfileStore } from "./profile-store.js";

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
    text: "launch the contract tests",
    ...overrides
  };
}

async function temporaryDatabase(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-profile-store-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  return join(directory, "bridge.sqlite");
}

test("opens an owner-only WAL database and deduplicates provider events", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  assert.equal(store.journalMode(), "wal");
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);

  const inserted = store.commitMessage(message());
  const duplicate = store.commitMessage(message({ text: "a replayed body" }));
  assert.equal(inserted.inserted, true);
  assert.deepEqual(duplicate, { recordId: inserted.recordId, inserted: false });
  assert.equal(store.recentMessages("qq:private:conversation-1").length, 1);
  assert.equal(store.recentMessages("qq:private:conversation-1")[0]?.text, "launch the contract tests");
  store.close();

  const reopened = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  assert.equal(reopened.recentMessages("qq:private:conversation-1")[0]?.recordId, inserted.recordId);
  reopened.close();
});

test("returns the bounded recent window in chronological order", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  store.commitMessage(message({ providerEventId: "event-1", observedAtMs: 1_000, text: "first" }));
  store.commitMessage(message({ providerEventId: "event-2", observedAtMs: 2_000, text: "second" }));
  store.commitMessage(message({ providerEventId: "event-3", observedAtMs: 3_000, text: "third" }));

  assert.deepEqual(
    store.recentMessages("qq:private:conversation-1", 2).map((entry) => entry.text),
    ["second", "third"]
  );
  store.close();
});

test("indexes text with FTS5 and can constrain search to one conversation", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  store.commitMessage(message({ providerEventId: "event-1", text: "launch native tests" }));
  store.commitMessage(
    message({
      providerEventId: "event-2",
      conversationKey: "qq:group:conversation-2",
      conversationKind: "group",
      text: "launch docker tests"
    })
  );
  store.commitMessage(message({ providerEventId: "event-3", text: "unrelated message" }));

  assert.equal(store.searchText({ text: "launch" }).length, 2);
  const constrained = store.searchText({
    text: "launch tests",
    conversationKey: "qq:group:conversation-2"
  });
  assert.equal(constrained.length, 1);
  assert.equal(constrained[0]?.text, "launch docker tests");
  assert.equal(typeof constrained[0]?.rank, "number");
  store.close();
});

test("fails closed when a database belongs to another Profile", async (context) => {
  const databasePath = await temporaryDatabase(context);
  SqliteProfileStore.open({ profileId: "alpha", databasePath }).close();
  assert.throws(
    () => SqliteProfileStore.open({ profileId: "beta", databasePath }),
    (error: unknown) => error instanceof ProfileStoreError && error.reason === "profile_mismatch"
  );
});

test("requires an explicit migration for an unknown schema", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const database = new Database(databasePath);
  database.pragma("user_version = 2");
  database.close();
  await chmod(databasePath, 0o600);
  assert.throws(
    () => SqliteProfileStore.open({ profileId: "alpha", databasePath }),
    (error: unknown) => error instanceof ProfileStoreError && error.reason === "migration_required"
  );
});

test("rejects a symlinked database path", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix symlink contract");
    return;
  }
  const databasePath = await temporaryDatabase(context);
  SqliteProfileStore.open({ profileId: "alpha", databasePath }).close();
  const linkPath = `${databasePath}.link`;
  await symlink(databasePath, linkPath);
  assert.throws(
    () => SqliteProfileStore.open({ profileId: "alpha", databasePath: linkPath }),
    (error: unknown) => error instanceof ProfileStoreError && error.reason === "insecure_store_path"
  );
});
