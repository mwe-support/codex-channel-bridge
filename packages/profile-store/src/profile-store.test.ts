import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import type { LogicalResultInput, NormalizedChannelMessage } from "@codex-channel-bridge/core";
import { secureWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

import { ProfileStoreError, SqliteProfileStore } from "./profile-store.js";
import { inspectProfileStore } from "./inspection.js";

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
  secureWindowsOwnerOnlyPath(directory, "directory");
  context.after(async () => rm(directory, { force: true, recursive: true }));
  return join(directory, "bridge.sqlite");
}

test("opens an owner-only WAL database and deduplicates provider events", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  assert.equal(store.journalMode(), "wal");
  if (process.platform !== "win32") assert.equal((await stat(databasePath)).mode & 0o777, 0o600);

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

test("scopes Outbox claims and lease recovery to one account while preserving segment order", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  context.after(() => store.close());
  for (let index = 0; index < 8; index++) {
    store.commitLogicalResult(logicalResult({ codexTurnId: `turn-busy-${index}` }));
  }
  store.commitLogicalResult(logicalResult({ channelAccountId: "qq-other", codexTurnId: "turn-other" }));
  const busy = store.claimOutbox({ channelAccountId: "qq-primary", nowMs: 1_000, leaseDurationMs: 100, limit: 8 });
  assert.equal(busy.length, 8);
  assert.ok(busy.every((entry) => entry.channelAccountId === "qq-primary" && entry.segmentIndex === 0));
  const other = store.claimOutbox({ channelAccountId: "qq-other", nowMs: 1_101, leaseDurationMs: 100 });
  assert.equal(other.length, 1);
  assert.equal(other[0]?.channelAccountId, "qq-other");
  assert.equal(other[0]?.segmentIndex, 0);
  assert.equal(store.outboxCountsForChannelAccount("qq-primary").leased, 8);
  const recovered = store.claimOutbox({ channelAccountId: "qq-primary", nowMs: 1_101, leaseDurationMs: 100, limit: 8 });
  assert.ok(recovered.every((entry) => entry.attemptNumber === 2));
  assert.equal(store.outboxCountsForChannelAccount("qq-other").leased, 1);
  store.settleOutbox({ outboxRecordId: other[0]!.outboxRecordId, leaseToken: other[0]!.leaseToken,
    outcome: "accepted", providerMessageId: "received", acceptedAtMs: 1_102 });
  assert.equal(store.claimOutbox({ channelAccountId: "qq-other", nowMs: 1_103, leaseDurationMs: 100 })[0]?.segmentIndex, 1);
  assert.throws(() => store.claimOutbox({ channelAccountId: "", nowMs: 1_104, leaseDurationMs: 100 }), /claim is invalid/);
});

test("inspects Profile storage read-only without requiring a runtime open", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  store.commitMessage(message());
  store.close();
  const report = await inspectProfileStore({ profileId: "alpha", databasePath });
  assert.equal(report.schemaVersion, 11);
  assert.equal(report.migrationRequired, false);
  assert.equal(report.quickCheck, "ok");
  assert.equal(report.profileMatches, true);
  assert.equal(report.counts.message_archive, 1);
});

test("commits attachment metadata with its message and settles mirrored bytes once", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const committed = store.commitObservation({
    message: message({ provider: "whatsapp" }),
    attachments: [
      {
        providerAttachmentId: "media-1",
        contentType: "image/jpeg",
        filename: "photo.jpg",
        declaredSizeBytes: 5,
        width: 10,
        height: 20,
        bytesState: "pending"
      }
    ]
  });
  assert.equal(committed.inserted, true);
  assert.equal(committed.attachments[0]?.bytesState, "pending");
  const settled = store.settleArchiveAttachment({
    attachmentRecordId: committed.attachments[0]!.attachmentRecordId,
    outcome: "mirrored",
    contentSha256: "a".repeat(64),
    mirroredSizeBytes: 5,
    settledAtMs: 2_000
  });
  assert.equal(settled.bytesState, "mirrored");
  assert.equal(store.mirroredMediaBytes(), 5);

  const duplicate = store.commitObservation({
    message: message({ provider: "whatsapp", text: "replay" }),
    attachments: []
  });
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.attachments[0]?.contentSha256, "a".repeat(64));
  assert.throws(
    () => store.settleArchiveAttachment({
      attachmentRecordId: settled.attachmentRecordId,
      outcome: "unavailable",
      failureReason: "late_failure",
      settledAtMs: 3_000
    }),
    (error: unknown) =>
      error instanceof ProfileStoreError && error.reason === "invalid_channel_message"
  );
  const pending = store.commitObservation({
    message: message({ provider: "whatsapp", providerEventId: "event-pending" }),
    attachments: [{
      providerAttachmentId: "media-pending",
      contentType: "application/octet-stream",
      bytesState: "pending"
    }]
  });
  assert.equal(store.abandonPendingArchiveAttachments({
    failureReason: "media_source_lost",
    settledAtMs: 4_000
  }), 1);
  assert.equal(
    store.archiveAttachments(pending.recordId)[0]?.failureReason,
    "media_source_lost"
  );
  store.close();
});

test("previews and atomically purges one exact conversation window", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const first = store.commitObservation({
    message: message({ providerEventId: "event-old", observedAtMs: 1_000 }),
    attachments: [{
      providerAttachmentId: "media-old",
      contentType: "image/jpeg",
      bytesState: "pending"
    }]
  });
  store.settleArchiveAttachment({
    attachmentRecordId: first.attachments[0]!.attachmentRecordId,
    outcome: "mirrored",
    contentSha256: "b".repeat(64),
    mirroredSizeBytes: 7,
    settledAtMs: 1_100
  });
  store.commitMessage(message({ providerEventId: "event-new", observedAtMs: 2_000 }));
  store.commitMessage(message({
    providerEventId: "event-other",
    conversationKey: "qq:private:conversation-2",
    providerConversationId: "conversation-2",
    observedAtMs: 500
  }));
  const scope = {
    kind: "conversation_before" as const,
    conversationKey: "qq:private:conversation-1",
    beforeMs: 1_500
  };
  const preview = store.previewArchivePurge(scope);
  assert.equal(preview.messageCount, 1);
  assert.equal(preview.referencedMediaBytes, 7);
  assert.equal(preview.liveReferenceCount, 0);
  const result = store.applyArchivePurge({
    scope,
    expectedMessageCount: preview.messageCount,
    expectedSelectionDigest: preview.selectionDigest,
    confirmedProfileId: "alpha",
    atMs: 3_000
  });
  assert.deepEqual(result.unreferencedContentSha256, ["b".repeat(64)]);
  assert.equal(store.recentMessages("qq:private:conversation-1").length, 1);
  assert.equal(store.recentMessages("qq:private:conversation-2").length, 1);
  assert.equal(store.auditRecords()[0]?.action, "archive_purge");
  store.close();
});

test("rejects Archive purge while a selected message has live Codex correlation", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const archived = store.commitMessage(message());
  const binding = store.createThreadBinding({
    profileId: "alpha",
    conversationKey: "qq:private:conversation-1",
    scope: "conversation",
    codexThreadId: "thread-live",
    boundAtMs: 1_001
  }).binding;
  store.acceptCodexInput({
    profileId: "alpha",
    archiveRecordId: archived.recordId,
    bindingId: binding.bindingId,
    codexThreadId: binding.codexThreadId,
    clientUserMessageId: "input-live",
    acceptedAtMs: 1_002
  });
  const preview = store.previewArchivePurge({ kind: "profile" });
  assert.equal(preview.liveReferenceCount, 1);
  assert.throws(
    () => store.applyArchivePurge({
      scope: { kind: "profile" },
      expectedMessageCount: preview.messageCount,
      expectedSelectionDigest: preview.selectionDigest,
      confirmedProfileId: "alpha",
      atMs: 2_000
    }),
    (error: unknown) =>
      error instanceof ProfileStoreError && error.reason === "invalid_store_configuration"
  );
  assert.equal(store.recentMessages("qq:private:conversation-1").length, 1);
  store.close();
});

test("persists session-aware Channel transport checkpoints across restarts", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const first = store.putChannelTransportCheckpoint({
    channelAccountId: "qq-primary",
    provider: "qq",
    sessionId: "session-a",
    sequence: 7,
    updatedAtMs: 1_000
  });
  assert.deepEqual(first, {
    channelAccountId: "qq-primary",
    provider: "qq",
    sessionId: "session-a",
    sequence: 7,
    updatedAtMs: 1_000
  });
  assert.equal(
    store.putChannelTransportCheckpoint({ ...first, sequence: 6, updatedAtMs: 2_000 }).sequence,
    7
  );
  assert.deepEqual(
    store.putChannelTransportCheckpoint({
      ...first,
      sessionId: "session-b",
      sequence: 1,
      updatedAtMs: 3_000
    }),
    {
      ...first,
      sessionId: "session-b",
      sequence: 1,
      updatedAtMs: 3_000
    }
  );
  assert.throws(
    () =>
      store.putChannelTransportCheckpoint({
        ...first,
        provider: "whatsapp",
        sessionId: "session-c",
        sequence: 1,
        updatedAtMs: 4_000
      }),
    /provider does not match/
  );
  store.close();

  const reopened = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  assert.deepEqual(reopened.getChannelTransportCheckpoint("qq-primary"), {
    ...first,
    sessionId: "session-b",
    sequence: 1,
    updatedAtMs: 3_000
  });
  reopened.clearChannelTransportCheckpoint("qq-primary");
  assert.equal(reopened.getChannelTransportCheckpoint("qq-primary"), undefined);
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

test("hybrid search can constrain FTS results to one conversation", async (context) => {
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

  assert.equal(
    store.searchHybrid({ text: "launch" })
      .filter((hit) => hit.matchedSignals.includes("lexical")).length,
    2
  );
  const constrained = store.searchHybrid({
    text: "launch tests",
    conversationKey: "qq:group:conversation-2"
  });
  assert.equal(constrained.length, 1);
  assert.equal(constrained[0]?.text, "launch docker tests");
  assert.ok(constrained[0]?.matchedSignals.includes("lexical"));
  store.close();
});

test("fuses exact, lexical, substring, fuzzy, structured, and recency Archive signals", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  store.commitMessage(message({ providerEventId: "event-1", observedAtMs: 1_000, text: "deploy native linux bridge" }));
  store.commitMessage(message({ providerEventId: "event-2", observedAtMs: 2_000, text: "deploy native linuz bridge" }));
  store.commitMessage(message({
    providerEventId: "event-3",
    provider: "whatsapp",
    channelAccountId: "wa-primary",
    channelAccountEpochId: "wa-epoch-1",
    conversationKey: "whatsapp:wa-primary:group:team",
    conversationKind: "group",
    providerConversationId: "team",
    providerIdentity: "member-2",
    observedAtMs: 3_000,
    text: "native linux deployment notes"
  }));
  store.commitMessage(message({ providerEventId: "event-4", observedAtMs: 4_000, text: "unrelated recent message" }));

  const results = store.searchHybrid({ text: "deploy native linux bridge", limit: 4 });
  assert.equal(results[0]?.text, "deploy native linux bridge");
  assert.ok(results[0]?.matchedSignals.includes("exact"));
  assert.ok(results[0]?.matchedSignals.includes("lexical"));
  assert.ok(results.some((entry) =>
    entry.text === "deploy native linuz bridge" && entry.matchedSignals.includes("fuzzy")
  ));
  assert.ok(results.every((entry, index) => index === 0 || results[index - 1]!.score >= entry.score));

  const structured = store.searchHybrid({
    provider: "whatsapp",
    conversationKind: "group",
    providerIdentity: "member-2",
    observedAfterMs: 2_500,
    observedBeforeMs: 3_500
  });
  assert.equal(structured.length, 1);
  assert.equal(structured[0]?.channelAccountId, "wa-primary");
  assert.deepEqual(structured[0]?.matchedSignals, ["recency", "structured"]);
  assert.throws(
    () => store.searchHybrid({ observedAfterMs: 5, observedBeforeMs: 5 }),
    /hybrid query is invalid/
  );
  store.close();
});

test("opens a concurrent read-only Archive view without mutating Profile state", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const writer = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  writer.commitMessage(message());
  const reader = SqliteProfileStore.open({ profileId: "alpha", databasePath, readOnly: true });
  assert.equal(reader.searchHybrid({ text: "contract tests" }).length, 1);
  assert.throws(
    () => reader.commitMessage(message({ providerEventId: "read-only-write" })),
    (error: unknown) => error instanceof ProfileStoreError && error.reason === "storage_failure"
  );
  assert.equal(writer.recentMessages("qq:private:conversation-1").length, 1);
  reader.close();
  writer.close();
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
  const replaced = store.replaceThreadBinding({
    profileId: "alpha",
    conversationKey: "qq:qq-primary:group:group-1",
    scope: "conversation",
    codexThreadId: "thread-replacement",
    boundAtMs: 1_003
  });
  assert.equal(replaced.binding.bindingId, conversation.binding.bindingId);
  assert.equal(replaced.binding.codexThreadId, "thread-replacement");
  assert.equal(store.detachThreadBinding(replaced.binding)?.codexThreadId, "thread-replacement");
  assert.equal(store.getThreadBinding(replaced.binding), undefined);
  const rebound = store.createThreadBinding({
    profileId: "alpha",
    conversationKey: "qq:qq-primary:group:group-1",
    scope: "conversation",
    codexThreadId: "thread-new",
    boundAtMs: 1_004
  });
  assert.equal(rebound.binding.bindingId, conversation.binding.bindingId);
  assert.equal(rebound.binding.codexThreadId, "thread-new");
  assert.equal(rebound.inserted, false);
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

test("reserves native stream sequences durably and binds only the matching terminal Outbox", async (context) => {
  const databasePath = await temporaryDatabase(context);
  let store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const input = message({ providerEventId: '["event-1",null]' });
  const archive = store.commitMessage(input);
  const target = { conversationKey: input.conversationKey, conversationKind: "private" as const,
    providerConversationId: input.providerConversationId, providerReplyEventId: "event-1" };
  assert.throws(() => store.beginAnswerStream({ archiveRecordId: archive.recordId, target }), /accepted input/);
  const binding = store.createThreadBinding({ profileId: "alpha", conversationKey: input.conversationKey,
    scope: "conversation", codexThreadId: "thread-1", boundAtMs: 1001 }).binding;
  const accepted = store.acceptCodexInput({ profileId: "alpha", archiveRecordId: archive.recordId,
    bindingId: binding.bindingId, codexThreadId: "thread-1", clientUserMessageId: "client-1", acceptedAtMs: 1002 });
  const stream = store.beginAnswerStream({ archiveRecordId: archive.recordId, target });
  assert.equal(stream.replySequence, 1);
  assert.deepEqual(store.beginAnswerStream({ archiveRecordId: archive.recordId, target }), stream);
  assert.throws(() => store.beginAnswerStream({ archiveRecordId: archive.recordId,
    target: { ...target, providerConversationId: "other-user" } }), /accepted input/);
  store.putAnswerStream({ ...stream, state: "sending" });
  store.close();
  store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  context.after(() => store.close());
  assert.equal(store.getAnswerStream(archive.recordId)?.state, "sending");
  assert.equal(store.getAnswerStream("other-profile-record"), undefined);
  store.transitionCodexInput({ correlationId: accepted.correlation.correlationId, state: "started",
    codexTurnId: "turn-1", updatedAtMs: 1003 });
  store.commitCodexTurnResult({ correlationId: accepted.correlation.correlationId, terminalStatus: "completed",
    updatedAtMs: 1004, result: logicalResult({ target, completedAtMs: 1004, segments: [{ text: "complete answer" }] }) });
  const [lease] = store.claimOutbox({ nowMs: 1005, leaseDurationMs: 100 });
  assert.equal(lease?.answerStreamId, archive.recordId);
  assert.equal(lease?.providerReplySequence, 2);
  assert.equal(JSON.stringify(store.getAnswerStream(archive.recordId)).includes("complete answer"), false);
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

test("file metadata survives restart in the same ordered Logical Result and detects conflicts", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const file = { sha256: "a".repeat(64), sizeBytes: 4, filename: "report.txt" };
  const input = { ...logicalResult(), segments: [{ text: "answer" }, { text: file.filename, file }] };
  let store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const committed = store.commitLogicalResult(input);
  assert.equal(store.commitLogicalResult(input).inserted, false);
  assert.throws(() => store.commitLogicalResult({ ...input, segments: [{ text: file.filename, file: { ...file, sha256: "b".repeat(64) } }] }));
  assert.throws(() => store.commitLogicalResult({ ...input, segments: [{ text: "bad", file: { ...file, filename: "../secret" } }] }));
  const [first] = store.claimOutbox({ nowMs: 1000, leaseDurationMs: 100 });
  store.settleOutbox({ outboxRecordId: first!.outboxRecordId, leaseToken: first!.leaseToken,
    outcome: "accepted", providerMessageId: "text-receipt", acceptedAtMs: 1010 });
  const [second] = store.claimOutbox({ nowMs: 1010, leaseDurationMs: 100 });
  assert.deepEqual(second!.file, file);
  store.close();
  store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const [retry] = store.claimOutbox({ nowMs: 1110, leaseDurationMs: 100 });
  assert.deepEqual(retry!.file, file);
  assert.equal(retry!.logicalResultId, committed.logicalResultId);
  assert.equal(retry!.outboxRecordId, second!.outboxRecordId);
  assert.equal(retry!.providerReplySequence, second!.providerReplySequence);
  store.close();
});

test("persists WhatsApp quoted-reply facts through an Outbox restart boundary", async (context) => {
  const databasePath = await temporaryDatabase(context);
  let store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  store.commitLogicalResult(logicalResult({
    provider: "whatsapp",
    channelAccountId: "wa-primary",
    target: {
      conversationKey: "whatsapp:wa-primary:group:120363000000000000@g.us",
      conversationKind: "group",
      providerConversationId: "120363000000000000@g.us",
      providerReplyEventId: "message-1",
      providerReplyParticipantId: "15553334444@s.whatsapp.net",
      providerReplyText: "original message"
    }
  }));
  store.close();

  store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const [lease] = store.claimOutbox({ nowMs: 1_000, leaseDurationMs: 100 });
  assert.deepEqual(lease?.target, {
    conversationKey: "whatsapp:wa-primary:group:120363000000000000@g.us",
    conversationKind: "group",
    providerConversationId: "120363000000000000@g.us",
    providerReplyEventId: "message-1",
    providerReplyParticipantId: "15553334444@s.whatsapp.net",
    providerReplyText: "original message"
  });
  store.close();
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

test("persists Approval presentation, terminal callback, and body-free Audit Records", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  const committed = store.commitApprovalRequest({
    approvalToken: "approval-token-1",
    operationKind: "command_execution",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    provider: "qq",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    providerIdentity: "participant-1",
    target: {
      conversationKey: "qq:qq-primary:private:user-1",
      conversationKind: "private",
      providerConversationId: "user-1",
      providerReplyEventId: "event-1"
    },
    prompt: "Codex requests approval. /approve approval-token-1 accept",
    createdAtMs: 2_000,
    expiresAtMs: 3_000
  });
  assert.equal(committed.approval.state, "pending");
  assert.equal(committed.approval.presentationState, "pending");

  const [lease] = store.claimOutbox({ nowMs: 2_000, leaseDurationMs: 100 });
  assert.equal(lease?.logicalResultId, committed.logicalResult.logicalResultId);
  assert.equal(lease?.text, "Codex requests approval. /approve approval-token-1 accept");
  store.settleOutbox({
    outboxRecordId: lease!.outboxRecordId,
    leaseToken: lease!.leaseToken,
    outcome: "accepted",
    providerMessageId: "provider-message-approval",
    acceptedAtMs: 2_010
  });
  const resolved = store.settleApprovalRequest({
    approvalToken: "approval-token-1",
    state: "responded",
    decision: "accept",
    settledAtMs: 2_020
  });
  assert.equal(resolved.state, "responded");
  assert.equal(resolved.presentationState, "accepted");
  assert.deepEqual(
    store.auditRecords().map((record) => [record.action, record.result]).reverse(),
    [
      ["approval_requested", "succeeded"],
      ["approval_presentation", "accepted"],
      ["approval_resolved", "responded"]
    ]
  );
  assert.doesNotMatch(JSON.stringify(store.auditRecords()), /participant-1|provider-message-approval|Codex requests/u);
  store.close();
});

test("abandons process-scoped Approval work without delivering it after restart", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  store.commitApprovalRequest({
    approvalToken: "approval-token-stale",
    operationKind: "file_change",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    provider: "qq",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    providerIdentity: "participant-1",
    target: {
      conversationKey: "qq:qq-primary:private:user-1",
      conversationKind: "private",
      providerConversationId: "user-1"
    },
    prompt: "stale approval prompt",
    createdAtMs: 2_000,
    expiresAtMs: 3_000
  });
  const [abandoned] = store.abandonPendingApprovalRequests({
    reasonCode: "app_server_generation_lost",
    settledAtMs: 2_100
  });
  assert.equal(abandoned?.state, "cancelled");
  assert.equal(abandoned?.reasonCode, "app_server_generation_lost");
  assert.equal(store.claimOutbox({ nowMs: 2_100, leaseDurationMs: 100 }).length, 0);
  assert.equal(store.outboxCounts().rejected, 1);
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
