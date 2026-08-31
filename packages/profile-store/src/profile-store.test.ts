import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import type { LogicalResultInput, NormalizedChannelMessage } from "@codex-channel-bridge/core";

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
    providerConversationId: "conversation-1",
    providerIdentity: "participant-1",
    observedAtMs: 1_000,
    text: "launch the contract tests",
    ...overrides
  };
}

function logicalResult(overrides: Partial<LogicalResultInput> = {}): LogicalResultInput {
  return {
    profileId: "alpha",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    provider: "qq",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    target: {
      conversationKey: "qq:qq-primary:private:user-1",
      conversationKind: "private",
      providerConversationId: "user-1",
      providerReplyEventId: "event-1"
    },
    completedAtMs: 1_000,
    segments: [{ text: "first segment" }, { text: "second segment" }],
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

test("binds conversation and participant scopes without copying Codex history", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const conversation = store.createThreadBinding({
    profileId: "alpha",
    conversationKey: "qq:qq-primary:group:group-1",
    scope: "conversation",
    codexThreadId: "thread-group",
    boundAtMs: 1_000
  });
  const participant = store.createThreadBinding({
    profileId: "alpha",
    conversationKey: "qq:qq-primary:group:group-1",
    scope: "participant",
    providerIdentity: "member-1",
    codexThreadId: "thread-member",
    boundAtMs: 1_001
  });

  assert.equal(conversation.inserted, true);
  assert.equal(participant.inserted, true);
  assert.equal(
    store.getThreadBinding({
      conversationKey: "qq:qq-primary:group:group-1",
      scope: "conversation"
    })?.codexThreadId,
    "thread-group"
  );
  assert.equal(
    store.getThreadBinding({
      conversationKey: "qq:qq-primary:group:group-1",
      scope: "participant",
      providerIdentity: "member-1"
    })?.codexThreadId,
    "thread-member"
  );
  assert.deepEqual(
    store.createThreadBinding({
      profileId: "alpha",
      conversationKey: "qq:qq-primary:group:group-1",
      scope: "conversation",
      codexThreadId: "orphaned-concurrent-thread",
      boundAtMs: 1_002
    }),
    { ...conversation, inserted: false }
  );
  store.close();
});

test("persists Codex input acceptance before its Turn outcome", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const archive = store.commitMessage(message());
  const binding = store.createThreadBinding({
    profileId: "alpha",
    conversationKey: "qq:private:conversation-1",
    scope: "conversation",
    codexThreadId: "thread-1",
    boundAtMs: 1_001
  }).binding;
  const accepted = store.acceptCodexInput({
    profileId: "alpha",
    archiveRecordId: archive.recordId,
    bindingId: binding.bindingId,
    codexThreadId: binding.codexThreadId,
    clientUserMessageId: "client-input-1",
    acceptedAtMs: 1_002
  });
  assert.equal(accepted.correlation.state, "accepted");
  assert.deepEqual(store.nonterminalCodexInputs(), [accepted.correlation]);
  const started = store.transitionCodexInput({
    correlationId: accepted.correlation.correlationId,
    state: "started",
    codexTurnId: "turn-1",
    updatedAtMs: 1_003
  });
  assert.equal(started.state, "started");
  assert.deepEqual(store.nonterminalCodexInputs(), [started]);
  const terminal = store.transitionCodexInput({
    correlationId: accepted.correlation.correlationId,
    state: "terminal",
    codexTurnId: "turn-1",
    terminalStatus: "completed",
    updatedAtMs: 1_004
  });
  assert.equal(terminal.terminalStatus, "completed");
  assert.deepEqual(store.nonterminalCodexInputs(), []);
  assert.deepEqual(
    store.acceptCodexInput({
      profileId: "alpha",
      archiveRecordId: archive.recordId,
      bindingId: binding.bindingId,
      codexThreadId: binding.codexThreadId,
      clientUserMessageId: "client-input-1",
      acceptedAtMs: 9_999
    }),
    { correlation: terminal, inserted: false }
  );
  assert.throws(
    () =>
      store.transitionCodexInput({
        correlationId: accepted.correlation.correlationId,
        state: "uncertain",
        reasonCode: "late_fault",
        updatedAtMs: 1_005
      }),
    (error: unknown) =>
      error instanceof ProfileStoreError && error.reason === "codex_input_conflict"
  );
  store.close();
});

test("commits one Logical Result and all Outbox segments atomically", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const first = store.commitLogicalResult(logicalResult());
  const duplicate = store.commitLogicalResult(logicalResult({ completedAtMs: 1_050 }));

  assert.equal(first.inserted, true);
  assert.equal(first.outboxRecordIds.length, 2);
  assert.deepEqual(duplicate, { ...first, inserted: false });
  assert.deepEqual(store.outboxCounts(), {
    pending: 2,
    leased: 0,
    retryWait: 0,
    accepted: 0,
    rejected: 0
  });
  assert.throws(
    () =>
      store.commitLogicalResult(
        logicalResult({ segments: [{ text: "different terminal output" }] })
      ),
    (error: unknown) =>
      error instanceof ProfileStoreError && error.reason === "logical_result_conflict"
  );
  store.close();

  const reopened = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  assert.deepEqual(reopened.commitLogicalResult(logicalResult({ completedAtMs: 2_000 })), duplicate);
  reopened.close();
});

test("atomically commits a correlated terminal Turn result and rolls back conflicts", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const archive = store.commitMessage(message());
  const binding = store.createThreadBinding({
    profileId: "alpha",
    conversationKey: "qq:private:conversation-1",
    scope: "conversation",
    codexThreadId: "thread-1",
    boundAtMs: 1_001
  }).binding;
  const accepted = store.acceptCodexInput({
    profileId: "alpha",
    archiveRecordId: archive.recordId,
    bindingId: binding.bindingId,
    codexThreadId: binding.codexThreadId,
    clientUserMessageId: "client-terminal",
    acceptedAtMs: 1_002
  }).correlation;
  store.transitionCodexInput({
    correlationId: accepted.correlationId,
    state: "started",
    codexTurnId: "turn-1",
    updatedAtMs: 1_003
  });

  const committed = store.commitCodexTurnResult({
    correlationId: accepted.correlationId,
    terminalStatus: "completed",
    updatedAtMs: 1_004,
    result: logicalResult({ completedAtMs: 1_004 })
  });
  assert.equal(committed.correlation.state, "terminal");
  assert.equal(committed.logicalResult.inserted, true);
  assert.deepEqual(store.nonterminalCodexInputs(), []);
  assert.equal(store.outboxCounts().pending, 2);

  const replay = store.commitCodexTurnResult({
    correlationId: accepted.correlationId,
    terminalStatus: "completed",
    updatedAtMs: 1_005,
    result: logicalResult({ completedAtMs: 1_005 })
  });
  assert.equal(replay.logicalResult.inserted, false);
  assert.equal(store.outboxCounts().pending, 2);
  store.close();
});

test("atomically commits restart uncertainty and its durable Channel notification", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const archive = store.commitMessage(message());
  const binding = store.createThreadBinding({
    profileId: "alpha",
    conversationKey: "qq:private:conversation-1",
    scope: "conversation",
    codexThreadId: "thread-uncertain",
    boundAtMs: 1_001
  }).binding;
  const accepted = store.acceptCodexInput({
    profileId: "alpha",
    archiveRecordId: archive.recordId,
    bindingId: binding.bindingId,
    codexThreadId: binding.codexThreadId,
    clientUserMessageId: "client-uncertain",
    acceptedAtMs: 1_002
  }).correlation;

  assert.throws(
    () =>
      store.commitCodexInputUncertainty({
        correlationId: accepted.correlationId,
        reasonCode: "turn_start_uncertain",
        completedAtMs: 1_001,
        text: "not delivered"
      }),
    (error: unknown) =>
      error instanceof ProfileStoreError && error.reason === "codex_input_conflict"
  );
  assert.equal(store.nonterminalCodexInputs().length, 1);
  assert.deepEqual(store.outboxCounts(), {
    pending: 0,
    leased: 0,
    retryWait: 0,
    accepted: 0,
    rejected: 0
  });

  const committed = store.commitCodexInputUncertainty({
    correlationId: accepted.correlationId,
    reasonCode: "turn_start_uncertain",
    completedAtMs: 2_000,
    text: "The previous Codex operation was not replayed automatically."
  });
  assert.equal(committed.correlation.state, "uncertain");
  assert.equal(committed.correlation.reasonCode, "turn_start_uncertain");
  assert.equal(committed.logicalResult.inserted, true);
  assert.deepEqual(store.nonterminalCodexInputs(), []);
  const [lease] = store.claimOutbox({ nowMs: 2_000, leaseDurationMs: 1_000 });
  assert.equal(lease?.target.providerConversationId, "conversation-1");
  assert.equal(lease?.target.providerReplyEventId, "event-1");
  assert.equal(lease?.text, "The previous Codex operation was not replayed automatically.");
  store.close();
});

test("leases Outbox segments in order and retries ambiguous delivery durably", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const committed = store.commitLogicalResult(logicalResult());

  const first = store.claimOutbox({ nowMs: 1_000, leaseDurationMs: 100, limit: 10 });
  assert.equal(first.length, 1);
  assert.equal(first[0]?.outboxRecordId, committed.outboxRecordIds[0]);
  assert.equal(first[0]?.segmentIndex, 0);
  assert.equal(first[0]?.attemptNumber, 1);
  assert.equal(first[0]?.providerReplySequence, 1);
  assert.equal(first[0]?.text, "first segment");
  store.settleOutbox({
    outboxRecordId: first[0]!.outboxRecordId,
    leaseToken: first[0]!.leaseToken,
    outcome: "accepted",
    providerMessageId: "provider-message-1",
    acceptedAtMs: 1_010
  });

  const second = store.claimOutbox({ nowMs: 1_010, leaseDurationMs: 100 });
  assert.equal(second.length, 1);
  assert.equal(second[0]?.segmentIndex, 1);
  assert.equal(second[0]?.providerReplySequence, 2);
  store.settleOutbox({
    outboxRecordId: second[0]!.outboxRecordId,
    leaseToken: second[0]!.leaseToken,
    outcome: "ambiguous",
    reasonCode: "provider_timeout",
    settledAtMs: 1_020,
    retryAtMs: 2_000
  });
  assert.equal(store.claimOutbox({ nowMs: 1_999, leaseDurationMs: 100 }).length, 0);

  const retry = store.claimOutbox({ nowMs: 2_000, leaseDurationMs: 100 });
  assert.equal(retry[0]?.outboxRecordId, second[0]?.outboxRecordId);
  assert.equal(retry[0]?.attemptNumber, 2);
  assert.equal(retry[0]?.providerReplySequence, 2);
  assert.deepEqual(store.outboxCounts(), {
    pending: 0,
    leased: 1,
    retryWait: 0,
    accepted: 1,
    rejected: 0
  });
  store.close();

  const reopened = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  assert.equal(reopened.claimOutbox({ nowMs: 2_099, leaseDurationMs: 100 }).length, 0);
  const recovered = reopened.claimOutbox({ nowMs: 2_100, leaseDurationMs: 100 });
  assert.equal(recovered[0]?.outboxRecordId, retry[0]?.outboxRecordId);
  assert.equal(recovered[0]?.attemptNumber, 3);
  assert.throws(
    () =>
      reopened.settleOutbox({
        outboxRecordId: retry[0]!.outboxRecordId,
        leaseToken: retry[0]!.leaseToken,
        outcome: "accepted",
        providerMessageId: "stale-receipt",
        acceptedAtMs: 2_101
      }),
    (error: unknown) =>
      error instanceof ProfileStoreError && error.reason === "outbox_lease_conflict"
  );
  reopened.close();
});

test("allocates QQ passive reply sequences durably across Logical Results", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  store.commitLogicalResult(logicalResult({ segments: [{ text: "first" }] }));
  store.commitLogicalResult(
    logicalResult({
      codexTurnId: "turn-2",
      segments: [{ text: "second" }, { text: "third" }]
    })
  );

  const leases = store.claimOutbox({ nowMs: 1_000, leaseDurationMs: 100, limit: 10 });
  assert.deepEqual(
    leases.map((entry) => entry.providerReplySequence).sort((left, right) => left! - right!),
    [1, 2]
  );
  const secondResult = leases.find((entry) => entry.providerReplySequence === 2);
  assert.ok(secondResult);
  store.settleOutbox({
    outboxRecordId: secondResult.outboxRecordId,
    leaseToken: secondResult.leaseToken,
    outcome: "accepted",
    providerMessageId: "provider-message-2",
    acceptedAtMs: 1_010
  });
  const [third] = store.claimOutbox({ nowMs: 1_010, leaseDurationMs: 100 });
  assert.equal(third?.providerReplySequence, 3);
  store.close();
});

test("a definite segment rejection terminates its remaining Logical Result segments", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  store.commitLogicalResult(
    logicalResult({
      segments: [{ text: "one" }, { text: "two" }, { text: "three" }]
    })
  );
  const [lease] = store.claimOutbox({ nowMs: 1_000, leaseDurationMs: 100 });
  assert.ok(lease);
  store.settleOutbox({
    outboxRecordId: lease.outboxRecordId,
    leaseToken: lease.leaseToken,
    outcome: "rejected",
    reasonCode: "provider_rejected",
    settledAtMs: 1_010
  });
  assert.deepEqual(store.outboxCounts(), {
    pending: 0,
    leased: 0,
    retryWait: 0,
    accepted: 0,
    rejected: 3
  });
  assert.equal(store.claimOutbox({ nowMs: 2_000, leaseDurationMs: 100 }).length, 0);
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
  database.pragma("user_version = 99");
  database.close();
  await chmod(databasePath, 0o600);
  assert.throws(
    () => SqliteProfileStore.open({ profileId: "alpha", databasePath }),
    (error: unknown) => error instanceof ProfileStoreError && error.reason === "migration_required"
  );
});

test("requires an explicit migration for the previous Profile schema", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const database = new Database(databasePath);
  database.pragma("user_version = 3");
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
