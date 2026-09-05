import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChannelAdapter, ChannelAnswerFrame } from "@codex-channel-bridge/core";
import type { AnswerStreamRecord, OutboxDeliveryLease } from "@codex-channel-bridge/profile-store";
import { ChannelAnswerStreams, type AnswerStreamStore } from "./channel-answer-streams.js";

test("native stream coalesces, finalizes via Outbox, and recovers receipts without another send", async () => {
  const records = new Map<string, AnswerStreamRecord>();
  const store: AnswerStreamStore = {
    beginAnswerStream: async ({ archiveRecordId }) => {
      if (!records.has(archiveRecordId)) records.set(archiveRecordId, { archiveRecordId, state: "idle",
        replySequence: records.size + 1, nextIndex: 0, prefixLength: 0,
        prefixSha256: createHash("sha256").update("").digest("hex") });
      return records.get(archiveRecordId)!;
    },
    getAnswerStream: async (id) => records.get(id),
    putAnswerStream: async (record) => { records.set(record.archiveRecordId, record); }
  };
  const frames: ChannelAnswerFrame[] = [];
  let failure = false;
  const adapter: ChannelAdapter = {
    start: async () => {}, stop: async () => {}, readiness: () => "ready", subscribeReadiness: () => () => {},
    sendText: async () => { throw new Error("Ordinary delivery must not be used for a successful stream"); },
    sendAnswerFrame: async (frame) => {
      assert.ok([...records.values()].some((r) => r.replySequence === frame.providerReplySequence && r.state === "sending"));
      frames.push(frame);
      if (failure) throw new Error("provider outcome uncertain");
      // Live QQ accepts a frame with remain_msg_len=0; it is not writable capacity.
      return { providerMessageId: `stream-${frame.providerReplySequence}`, acceptedAtMs: 1000, remainingCharacters: 0 };
    }
  };
  const streams = new ChannelAnswerStreams(store);
  const target = { conversationKey: "dm", conversationKind: "private" as const,
    providerConversationId: "test-user", providerReplyEventId: "test-anchor" };
  const lease: OutboxDeliveryLease = { answerStreamId: "archive-1", outboxRecordId: "outbox-1", logicalResultId: "result-1",
    segmentIndex: 0, provider: "qq", channelAccountId: "account-1", channelAccountEpochId: "epoch-1",
    target, providerReplySequence: 10, text: "hello world", attemptNumber: 1, leaseToken: "lease-1", leaseExpiresAtMs: 5000 };
  const stream = streams.start("archive-1", target, adapter)!;
  stream.update("h"); stream.update("hello");
  await delay(20);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.text, "hello");
  stream.update("hello world");
  await stream.stop();
  const receipt = await streams.finish(lease, adapter);
  assert.equal(receipt?.providerMessageId, "stream-1");
  assert.deepEqual(frames.map((f) => [f.index, f.providerReplySequence, f.done]), [[0, 1, false], [1, 1, true]]);
  assert.deepEqual(await new ChannelAnswerStreams(store).finish(lease, adapter), receipt);
  assert.equal(frames.length, 2);
  assert.equal(streams.start("group", { ...target, conversationKind: "group" }, adapter), undefined);
  assert.equal(await streams.finish({ ...lease, answerStreamId: undefined }, adapter), undefined);

  const second = streams.start("archive-2", target, adapter)!;
  failure = true;
  second.update("hello");
  await delay(20);
  await second.stop();
  assert.equal(records.get("archive-2")?.state, "sending");
  failure = false;
  const before = frames.length;
  assert.equal(await new ChannelAnswerStreams(store).finish({ ...lease, answerStreamId: "archive-2" }, adapter), undefined);
  assert.equal(frames.length, before);
  assert.equal(records.get("archive-2")?.state, "fallback");

  const third = streams.start("archive-3", target, adapter)!;
  third.update("a different answer");
  await delay(20);
  await third.stop();
  assert.equal(await streams.finish({ ...lease, answerStreamId: "archive-3" }, adapter), undefined);
  assert.equal(records.get("archive-3")?.state, "fallback");
  await streams.stop();
});
