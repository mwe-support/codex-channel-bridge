import assert from "node:assert/strict";
import test from "node:test";

import type { QQBot, QQBotInboundMessage, QQBotOptions } from "@tencent-connect/qqbot-nodejs";
import { ApiError } from "@tencent-connect/qqbot-nodejs/protocol";

import { ChannelDeliveryError, parseChannelText, type ProviderInboundEvent } from "@codex-channel-bridge/core";

import {
  QQChannelAdapter,
  type QQBotClient,
  type QQChannelAdapterOptions
} from "./qq-adapter.js";

const options: QQChannelAdapterOptions = {
  channelAccountId: "qq-primary",
  appId: "test-app",
  appSecret: "test-secret",
  gatewaySessionRepository: {
    load: async () => null,
    save: async () => undefined,
    clear: async () => undefined
  }
};

class FakeBot implements QQBotClient {
  readonly uploads: Array<Parameters<QQBot["uploadMedia"]>[0]> = [];
  uploadFailure?: Error;
  async uploadMedia(value: Parameters<QQBot["uploadMedia"]>[0]) {
    this.uploads.push(value);
    if (this.uploadFailure) throw this.uploadFailure;
    return { file_info: "opaque-file", file_uuid: "file-1", ttl: 300 };
  }
  readonly frames: Array<{ path: string; body: unknown }> = [];
  readonly api = { post: async <T>(path: string, body?: unknown): Promise<T> => {
    this.frames.push({ path, body });
    return { id: "stream-1", timestamp: 1000, remain_msg_len: 4995 } as T;
  } };
  readonly handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  readonly sent: Array<{
    target: { scope: "c2c" | "group"; targetId: string; msgId?: string };
    content: string;
  }> = [];
  readonly sentRaw: Array<Parameters<QQBot["send"]>[0]> = [];
  middlewareCount = 0;
  factoryOptions?: QQBotOptions;
  sendFailure?: Error;
  rawSendFailure?: Error;
  startFailure?: Error;
  #resolveStop!: () => void;

  use(...middleware: unknown[]): this {
    this.middlewareCount += middleware.length;
    return this;
  }

  on(event: string, handler: (...args: never[]) => unknown): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  async start(): Promise<void> {
    if (this.startFailure) throw this.startFailure;
    queueMicrotask(() => this.emit("ready", {}));
    await new Promise<void>((resolve) => {
      this.#resolveStop = resolve;
    });
  }

  stop(): void {
    this.#resolveStop?.();
  }

  async send(options: Parameters<QQBot["send"]>[0]): Promise<{ id: string; timestamp: string }> {
    this.sentRaw.push(options);
    if (this.rawSendFailure) throw this.rawSendFailure;
    return { id: "provider-result-1", timestamp: "2026-08-26T12:00:00.000Z" };
  }

  async sendText(
    target: { scope: "c2c" | "group"; targetId: string; msgId?: string },
    content: string
  ): Promise<{ id: string; timestamp: string }> {
    if (this.sendFailure) throw this.sendFailure;
    this.sent.push({ target, content });
    return { id: "provider-result-1", timestamp: "2026-08-26T12:00:00.000Z" };
  }

  async emitMessage(receivedAt: number, message: QQBotInboundMessage): Promise<void> {
    await this.emit("message", { receivedAt }, message);
  }

  emit(event: string, ...args: unknown[]): unknown {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      result = handler(...(args as never[]));
    }
    return result;
  }
}

test("QQ file upload does not send; the message uses the durable sequence and original scope", async () => {
  const bot = new FakeBot();
  const channel = adapter(bot);
  await channel.start(async () => {});
  try {
    for (const conversationKind of ["private", "group"] as const) {
      await channel.sendFile({ logicalResultId: "result-file", segmentIndex: 1, providerReplySequence: 6,
        target: { conversationKey: "conversation", conversationKind, providerConversationId: "target", providerReplyEventId: "inbound" },
        filename: "report.txt", bytes: Buffer.from("test") });
      assert.equal(bot.uploads.at(-1)!.srvSendMsg, false);
      assert.equal(bot.uploads.at(-1)!.fileType, 4);
      assert.equal(bot.sentRaw.at(-1)!.target.scope, conversationKind === "private" ? "c2c" : "group");
      assert.deepEqual(bot.sentRaw.at(-1)!.extra, { msg_seq: 6 });
      assert.deepEqual(bot.sentRaw.at(-1)!.media, { file_info: "opaque-file" });
    }
    assert.equal(bot.sent.length, 0);
    const delivery = { logicalResultId: "result-file", segmentIndex: 1, providerReplySequence: 6,
      target: { conversationKey: "conversation", conversationKind: "private" as const,
        providerConversationId: "target", providerReplyEventId: "inbound" },
      filename: "report.txt", bytes: Buffer.from("test") };
    for (const [failure, outcome] of [
      [new ApiError("rate limited", 429, "/files"), "deferred"],
      [new ApiError("forbidden", 403, "/files"), "rejected"],
      [new Error("connection reset"), "ambiguous"]
    ] as const) {
      bot.uploadFailure = failure;
      await assert.rejects(channel.sendFile(delivery),
        (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === outcome);
      assert.equal(bot.sentRaw.length, 2); // failed upload must not send a message
    }
    bot.uploadFailure = undefined;
    bot.rawSendFailure = new Error("send response lost");
    await assert.rejects(channel.sendFile(delivery),
      (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "ambiguous");
    const uploads = bot.uploads.length;
    bot.rawSendFailure = undefined;
    assert.equal((await channel.sendFile(delivery)).outcome, "accepted");
    assert.equal(bot.uploads.length, uploads + 1); // retry obtains a fresh provider file reference
    assert.deepEqual(bot.sentRaw.at(-1)!.extra, { msg_seq: 6 });
  } finally { await channel.stop(); }
});

function adapter(fake: FakeBot): QQChannelAdapter {
  return new QQChannelAdapter(options, (factoryOptions) => {
    fake.factoryOptions = factoryOptions;
    return fake;
  });
}

test("QQ C2C stream uses one anchor and stable identity/sequence, never group", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  await channel.start(async () => {});
  const target = { conversationKey: "dm", conversationKind: "private" as const,
    providerConversationId: "user-test", providerReplyEventId: "inbound-test" };
  const first = await channel.sendAnswerFrame({ target, index: 0, text: "hello", done: false, providerReplySequence: 3 });
  assert.equal(first.remainingCharacters, 4995);
  await channel.sendAnswerFrame({ target, index: 1, text: "hello world", done: true,
    providerReplySequence: 3, providerMessageId: first.providerMessageId });
  assert.deepEqual(fake.frames, [
    { path: "/v2/users/user-test/stream_messages", body: { input_mode: "replace", input_state: 1,
      content_type: "markdown", content_raw: "hello", msg_id: "inbound-test", msg_seq: 3, index: 0 } },
    { path: "/v2/users/user-test/stream_messages", body: { input_mode: "replace", input_state: 10,
      content_type: "markdown", content_raw: "hello world", msg_id: "inbound-test", msg_seq: 3, index: 1, stream_msg_id: "stream-1" } }
  ]);
  await assert.rejects(channel.sendAnswerFrame({ target: { ...target, conversationKind: "group" },
    index: 0, text: "no", done: false, providerReplySequence: 1 }), ChannelDeliveryError);
  assert.equal(fake.frames.length, 2);
  assert.equal(fake.sent.length + fake.sentRaw.length, 0);
  await channel.stop();
});

function inbound(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
  return {
    rawEventType: "C2C_MESSAGE_CREATE",
    kind: "c2c",
    senderId: "user-openid",
    content: "hello",
    messageId: "message-1",
    timestamp: "2026-08-26T10:00:00.000Z",
    replyTarget: { scope: "c2c", targetId: "user-openid", msgId: "message-1" },
    raw: {
      id: "message-1",
      content: "hello",
      timestamp: "2026-08-26T10:00:00.000Z",
      author: { user_openid: "user-openid" }
    },
    ...overrides
  } as QQBotInboundMessage;
}

test("starts with the narrow QQ intent and normalizes C2C messages", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  const events: ProviderInboundEvent[] = [];
  await channel.start(async (event) => {
    events.push(event);
  });
  assert.equal(channel.readiness(), "ready");
  assert.equal(fake.factoryOptions?.intents, 1 << 25);
  assert.equal(fake.factoryOptions?.transport, "websocket");
  assert.equal(fake.factoryOptions?.tokenPrefetch, "sync");
  assert.equal(fake.middlewareCount, 2);

  await fake.emitMessage(1, inbound({ msgIdx: "7" }));
  assert.deepEqual(events[0], {
    message: {
      provider: "qq",
      providerEventId: '["message-1","7"]',
      conversationKind: "private",
      providerConversationId: "user-openid",
      providerIdentity: "user-openid",
      observedAtMs: Date.parse("2026-08-26T10:00:00.000Z"),
      text: "hello"
    },
    attention: "direct",
    replyTarget: {
      conversationKind: "private",
      providerConversationId: "user-openid",
      providerReplyEventId: "message-1"
    }
  });
  await channel.stop();
  assert.equal(channel.readiness(), "stopped");
});

test("archives official QQ attachment facts as metadata without fetching bytes", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  const events: ProviderInboundEvent[] = [];
  await channel.start(async (event) => { events.push(event); });
  await fake.emitMessage(1, inbound({
    attachments: [{
      content_type: "image/jpeg",
      filename: "photo.jpg",
      url: "https://example.invalid/provider-link",
      size: 123,
      width: 10,
      height: 20
    }]
  } as Partial<QQBotInboundMessage>));
  assert.deepEqual(events[0]?.attachments, [{
    providerAttachmentId: "0",
    contentType: "image/jpeg",
    filename: "photo.jpg",
    sourceUrl: "https://example.invalid/provider-link",
    declaredSizeBytes: 123,
    width: 10,
    height: 20
  }]);
  await channel.stop();
});

test("distinguishes mentioned and passive QQ group messages", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  const events: ProviderInboundEvent[] = [];
  await channel.start(async (event) => {
    events.push(event);
  });
  const group = inbound({
    rawEventType: "GROUP_AT_MESSAGE_CREATE",
    kind: "group",
    senderId: "member-openid",
    groupOpenid: "group-openid",
    replyTarget: { scope: "group", targetId: "group-openid", msgId: "message-1" }
  });
  await fake.emitMessage(1, group);
  await fake.emitMessage(1, { ...group, rawEventType: "GROUP_MESSAGE_CREATE", messageId: "message-2" });
  assert.equal(events[0]?.attention, "mention");
  assert.equal(events[0]?.message.conversationKind, "group");
  assert.equal(events[0]?.message.providerIdentity, "member-openid");
  assert.equal(events[0]?.replyTarget.providerConversationId, "group-openid");
  assert.equal(events[1]?.attention, "passive");
  await fake.emitMessage(1, {
    ...group,
    rawEventType: "GROUP_MESSAGE_CREATE",
    messageId: "message-3",
    mentions: [{ is_you: true, bot: true }]
  });
  assert.equal(events[2]?.attention, "mention");
  await channel.stop();
});

test("normalizes leading opaque mention markers before core command parsing only in addressed groups", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  const events: ProviderInboundEvent[] = [];
  await channel.start(async (event) => { events.push(event); });
  const group = inbound({ kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE",
    groupOpenid: "group-test", content: "<@!opaque-bot-id> /model" });
  await fake.emitMessage(1, group);
  assert.deepEqual(parseChannelText(events[0]!.message.text!), {
    kind: "command", command: { kind: "model.read" }
  });
  await fake.emitMessage(2, { ...group, content: "<@opaque-bot-id> //model" });
  assert.deepEqual(parseChannelText(events[1]!.message.text!), { kind: "ordinary", text: "/model" });
  await fake.emitMessage(3, { ...group, rawEventType: "GROUP_MESSAGE_CREATE" });
  assert.equal(events[2]!.message.text, group.content);
  assert.equal(events[2]!.attention, "passive");
  await fake.emitMessage(4, { ...group, content: "hello <@other> /model" });
  assert.equal(events[3]!.message.text, "hello <@other> /model");
  await fake.emitMessage(5, inbound({ content: group.content }));
  assert.equal(events[4]!.message.text, group.content);
  await channel.stop();
});

test("maps accepted, rejected, and ambiguous QQ delivery outcomes", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  await channel.start(async () => undefined);
  const delivery = {
    logicalResultId: "result-1",
    segmentIndex: 0,
    target: {
      conversationKey: "qq:qq-primary:private:user-openid",
      conversationKind: "private" as const,
      providerConversationId: "user-openid",
      providerReplyEventId: "message-1"
    },
    providerReplySequence: 7,
    text: "done"
  };
  const receipt = await channel.sendText(delivery);
  assert.equal(receipt.outcome, "accepted");
  assert.equal(receipt.providerMessageId, "provider-result-1");
  assert.deepEqual(fake.sentRaw[0], {
    target: { scope: "c2c", targetId: "user-openid", msgId: "message-1" },
    msgType: 0,
    content: "done",
    extra: { msg_seq: 7 }
  });

  fake.rawSendFailure = new ApiError("bad request", 400, "/messages");
  await assert.rejects(
    channel.sendText(delivery),
    (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "rejected"
  );
  fake.rawSendFailure = new Error("connection reset");
  await assert.rejects(
    channel.sendText(delivery),
    (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "ambiguous"
  );
  fake.rawSendFailure = new ApiError("rate limited", 429, "/messages");
  await assert.rejects(
    channel.sendText(delivery),
    (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "deferred"
  );
  await channel.stop();
});

test("retries an explicitly expired passive reply once as a proactive message", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  await channel.start(async () => undefined);
  fake.rawSendFailure = new ApiError(
    "expired reply",
    400,
    "/v2/users/user-openid/messages",
    304103
  );

  const receipt = await channel.sendText({
    logicalResultId: "result-1",
    segmentIndex: 0,
    target: {
      conversationKey: "qq:qq-primary:private:user-openid",
      conversationKind: "private",
      providerConversationId: "user-openid",
      providerReplyEventId: "message-1"
    },
    providerReplySequence: 3,
    text: "long task completed"
  });

  assert.equal(receipt.outcome, "accepted");
  assert.equal(fake.sentRaw.length, 1);
  assert.deepEqual(fake.sent, [
    {
      target: { scope: "c2c", targetId: "user-openid" },
      content: "long task completed"
    }
  ]);
  await channel.stop();
});

test("applies the same narrow expired-anchor fallback to group delivery", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  await channel.start(async () => undefined);
  fake.rawSendFailure = new ApiError(
    "expired group reply",
    400,
    "/v2/groups/group-openid/messages",
    40034005
  );

  await channel.sendText({
    logicalResultId: "result-1",
    segmentIndex: 0,
    target: {
      conversationKey: "qq:qq-primary:group:group-openid",
      conversationKind: "group",
      providerConversationId: "group-openid",
      providerReplyEventId: "message-1"
    },
    providerReplySequence: 2,
    text: "group task completed"
  });

  assert.deepEqual(fake.sent[0]?.target, { scope: "group", targetId: "group-openid" });
  await channel.stop();
});

test("does not fall back for unrelated provider rejection or missing durable sequence", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  await channel.start(async () => undefined);
  const passive = {
    logicalResultId: "result-1",
    segmentIndex: 0,
    target: {
      conversationKey: "qq:qq-primary:group:group-openid",
      conversationKind: "group" as const,
      providerConversationId: "group-openid",
      providerReplyEventId: "message-1"
    },
    providerReplySequence: 2,
    text: "done"
  };
  fake.rawSendFailure = new ApiError("forbidden", 403, "/messages", 40034024);
  await assert.rejects(
    channel.sendText(passive),
    (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "rejected"
  );
  assert.equal(fake.sent.length, 0);

  await assert.rejects(
    channel.sendText({ ...passive, providerReplySequence: undefined }),
    (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "rejected"
  );
  await assert.rejects(
    channel.sendText({
      ...passive,
      target: { ...passive.target, providerReplyEventId: "" }
    }),
    (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "rejected"
  );
  await channel.stop();
});

test("fails startup closed when the QQ client never reaches ready", async () => {
  const fake = new FakeBot();
  fake.startFailure = new Error("invalid credentials");
  const channel = adapter(fake);
  await assert.rejects(channel.start(async () => undefined), /failed before ready/);
  assert.equal(channel.readiness(), "degraded");
  await channel.stop();
});
