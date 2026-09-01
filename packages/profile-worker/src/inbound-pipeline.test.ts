import assert from "node:assert/strict";
import test from "node:test";

import type {
  NormalizedChannelMessage,
  ProviderInboundEvent,
  TrustedChannelContext
} from "@codex-channel-bridge/core";

import {
  InboundPipeline,
  InboundPipelineError,
  type InboundArchive
} from "./inbound-pipeline.js";

class FakeArchive implements InboundArchive {
  readonly messages: NormalizedChannelMessage[] = [];
  inserted = true;

  async commitObservation(input: import("@codex-channel-bridge/profile-store").CommitArchiveObservationInput) {
    this.messages.push(input.message);
    return { recordId: "archive-1", inserted: this.inserted, attachments: [] };
  }
}

const context: TrustedChannelContext = {
  profileId: "profile-a",
  provider: "qq",
  channelAccountId: "qq-primary",
  channelAccountEpochId: "epoch-7"
};

function providerEvent(): ProviderInboundEvent {
  return {
    message: {
      provider: "qq",
      providerEventId: '["message-1",null]',
      conversationKind: "private",
      providerConversationId: "participant/1",
      providerIdentity: "participant/1",
      observedAtMs: 1_000,
      text: "hello"
    },
    attention: "direct",
    replyTarget: {
      conversationKind: "private",
      providerConversationId: "participant/1",
      providerReplyEventId: "message-1"
    }
  };
}

test("injects Worker-owned authority and archives before exposing an observed event", async () => {
  const archive = new FakeArchive();
  const pipeline = new InboundPipeline(archive);
  const untrusted = providerEvent() as ProviderInboundEvent & {
    profileId?: string;
    channelAccountEpochId?: string;
  };
  untrusted.profileId = "other-profile";
  untrusted.channelAccountEpochId = "other-epoch";

  const disposition = await pipeline.accept(context, untrusted);

  assert.equal(disposition.kind, "observed");
  assert.deepEqual(archive.messages, [
    {
      profileId: "profile-a",
      provider: "qq",
      channelAccountId: "qq-primary",
      channelAccountEpochId: "epoch-7",
      providerEventId: '["message-1",null]',
      conversationKey: "qq:qq-primary:private:participant%2F1",
      conversationKind: "private",
      providerConversationId: "participant/1",
      providerIdentity: "participant/1",
      observedAtMs: 1_000,
      text: "hello"
    }
  ]);
  if (disposition.kind === "observed") {
    assert.equal(disposition.archiveRecordId, "archive-1");
    assert.equal(
      disposition.event.replyTarget.conversationKey,
      "qq:qq-primary:private:participant%2F1"
    );
  }
});

test("returns duplicate without exposing replayed input for downstream work", async () => {
  const archive = new FakeArchive();
  archive.inserted = false;
  const disposition = await new InboundPipeline(archive).accept(context, providerEvent());
  assert.deepEqual(disposition, { kind: "duplicate", archiveRecordId: "archive-1" });
});

test("fails before persistence when provider facts do not match trusted context", async () => {
  const archive = new FakeArchive();
  const event = providerEvent();
  const mismatched = {
    ...event,
    message: { ...event.message, provider: "whatsapp" as const }
  };
  await assert.rejects(
    new InboundPipeline(archive).accept(context, mismatched),
    (error: unknown) =>
      error instanceof InboundPipelineError && error.reason === "provider_context_mismatch"
  );
  assert.equal(archive.messages.length, 0);
});

test("derives account-scoped Conversation Keys from trusted context", async () => {
  const archive = new FakeArchive();
  const pipeline = new InboundPipeline(archive);
  await pipeline.accept({ ...context, channelAccountId: "qq-secondary" }, providerEvent());
  assert.equal(
    archive.messages[0]?.conversationKey,
    "qq:qq-secondary:private:participant%2F1"
  );
});
