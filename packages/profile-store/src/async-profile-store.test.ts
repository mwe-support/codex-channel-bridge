import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LogicalResultInput, NormalizedChannelMessage } from "@codex-channel-bridge/core";

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
    providerConversationId: "conversation-1",
    providerIdentity: "participant-1",
    observedAtMs: 1_000,
    text: "worker-thread archive",
    ...overrides
  };
}

function logicalResult(): LogicalResultInput {
  return {
    profileId: "alpha",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    provider: "qq",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    target: {
      conversationKey: "qq:private:conversation-1",
      conversationKind: "private",
      providerConversationId: "conversation-1"
    },
    completedAtMs: 1_000,
    segments: [{ text: "durable result" }]
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
  const first = await store.commitObservation({ message: message(), attachments: [] });
  const duplicate = await store.commitObservation({
    message: message({ text: "replayed" }),
    attachments: []
  });
  assert.equal(first.inserted, true);
  assert.deepEqual(duplicate, { recordId: first.recordId, inserted: false, attachments: [] });
  assert.equal((await store.recentMessages("qq:private:conversation-1"))[0]?.text, "worker-thread archive");
  const hybrid = await store.searchHybrid({ text: "worker-thread archive" });
  assert.equal(hybrid.length, 1);
  assert.ok(hybrid[0]?.matchedSignals.includes("exact"));
  const pending = await store.commitObservation({
    message: message({ provider: "whatsapp", providerEventId: "event-pending" }),
    attachments: [{
      providerAttachmentId: "media-pending",
      contentType: "application/octet-stream",
      bytesState: "pending"
    }]
  });
  assert.equal(await store.abandonPendingArchiveAttachments({
    failureReason: "media_source_lost",
    settledAtMs: 2_000
  }), 1);
  await store.close();
});

test("executes Logical Result and Outbox transitions through the storage Worker", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = await ProfileStore.open({ profileId: "alpha", databasePath });
  const archive = await store.commitObservation({ message: message(), attachments: [] });
  const binding = (await store.createThreadBinding({
    profileId: "alpha",
    conversationKey: "qq:private:conversation-1",
    scope: "conversation",
    codexThreadId: "thread-1",
    boundAtMs: 1_001
  })).binding;
  const accepted = (await store.acceptCodexInput({
    profileId: "alpha",
    archiveRecordId: archive.recordId,
    bindingId: binding.bindingId,
    codexThreadId: "thread-1",
    clientUserMessageId: "client-1",
    acceptedAtMs: 1_002
  })).correlation;
  await store.transitionCodexInput({
    correlationId: accepted.correlationId,
    state: "started",
    codexTurnId: "turn-1",
    updatedAtMs: 1_003
  });
  const committed = await store.commitCodexTurnResult({
    correlationId: accepted.correlationId,
    terminalStatus: "completed",
    updatedAtMs: 1_004,
    result: logicalResult()
  });
  const [lease] = await store.claimOutbox({ nowMs: 1_000, leaseDurationMs: 100 });
  assert.equal(lease?.logicalResultId, committed.logicalResult.logicalResultId);
  assert.equal(lease?.providerReplySequence, undefined);
  assert.ok(lease);
  assert.equal(
    (
      await store.settleOutbox({
        outboxRecordId: lease.outboxRecordId,
        leaseToken: lease.leaseToken,
        outcome: "accepted",
        providerMessageId: "provider-message-1",
        acceptedAtMs: 1_010
      })
    ).status,
    "accepted"
  );
  assert.equal((await store.outboxCounts()).accepted, 1);
  await store.close();
});

test("executes durable Approval and Audit transitions through the storage Worker", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = await ProfileStore.open({ profileId: "alpha", databasePath });
  const committed = await store.commitApprovalRequest({
    approvalToken: "approval-async-1",
    operationKind: "file_change",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    provider: "qq",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    providerIdentity: "participant-1",
    target: {
      conversationKey: "qq:private:conversation-1",
      conversationKind: "private",
      providerConversationId: "conversation-1"
    },
    prompt: "approval prompt",
    createdAtMs: 1_000,
    expiresAtMs: 2_000
  });
  assert.equal(committed.approval.state, "pending");
  const [lease] = await store.claimOutbox({ nowMs: 1_000, leaseDurationMs: 100 });
  assert.ok(lease);
  await store.settleOutbox({
    outboxRecordId: lease.outboxRecordId,
    leaseToken: lease.leaseToken,
    outcome: "accepted",
    providerMessageId: "provider-approval-1",
    acceptedAtMs: 1_010
  });
  const resolved = await store.settleApprovalRequest({
    approvalToken: "approval-async-1",
    state: "responded",
    decision: "decline",
    settledAtMs: 1_020
  });
  assert.equal(resolved.presentationState, "accepted");
  assert.equal((await store.auditRecords()).length, 3);
  await store.close();
});

test("preserves typed store failures across the Worker-thread seam", async (context) => {
  const databasePath = await temporaryDatabase(context);
  const store = await ProfileStore.open({ profileId: "alpha", databasePath });
  await assert.rejects(
    store.commitObservation({ message: message({ profileId: "beta" }), attachments: [] }),
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
