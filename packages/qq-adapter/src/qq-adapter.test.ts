import assert from "node:assert/strict";
import test from "node:test";

import type { QQBotInboundMessage, QQBotOptions } from "@tencent-connect/qqbot-nodejs";
import { ApiError } from "@tencent-connect/qqbot-nodejs/protocol";

import { ChannelDeliveryError, type InboundChannelEvent } from "@codex-channel-bridge/core";

import {
  QQChannelAdapter,
  type QQBotClient,
  type QQChannelAdapterOptions
} from "./qq-adapter.js";

const options: QQChannelAdapterOptions = {
  profileId: "alpha",
  channelAccountId: "qq-primary",
  channelAccountEpochId: "epoch-1",
  appId: "test-app",
  appSecret: "test-secret"
};

class FakeBot implements QQBotClient {
  readonly handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  readonly sent: Array<{
    target: { scope: "c2c" | "group"; targetId: string; msgId?: string };
    content: string;
  }> = [];
  middlewareCount = 0;
  factoryOptions?: QQBotOptions;
  sendFailure?: Error;
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

function adapter(fake: FakeBot): QQChannelAdapter {
  return new QQChannelAdapter(options, (factoryOptions) => {
    fake.factoryOptions = factoryOptions;
    return fake;
  });
}

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
  const events: InboundChannelEvent[] = [];
  await channel.start(async (event) => {
    events.push(event);
  });
  assert.equal(channel.readiness(), "ready");
  assert.equal(fake.factoryOptions?.intents, 1 << 25);
  assert.equal(fake.factoryOptions?.transport, "websocket");
  assert.equal(fake.factoryOptions?.tokenPrefetch, "sync");
  assert.equal(fake.middlewareCount, 1);

  await fake.emitMessage(1, inbound({ msgIdx: "7" }));
  assert.deepEqual(events[0], {
    message: {
      profileId: "alpha",
      provider: "qq",
      channelAccountId: "qq-primary",
      channelAccountEpochId: "epoch-1",
      providerEventId: '["message-1","7"]',
      conversationKey: "qq:qq-primary:private:user-openid",
      conversationKind: "private",
      providerIdentity: "user-openid",
      observedAtMs: Date.parse("2026-08-26T10:00:00.000Z"),
      text: "hello"
    },
    attention: "direct",
    replyTarget: {
      conversationKey: "qq:qq-primary:private:user-openid",
      conversationKind: "private",
      providerConversationId: "user-openid",
      providerReplyEventId: "message-1"
    }
  });
  await channel.stop();
  assert.equal(channel.readiness(), "stopped");
});

test("distinguishes mentioned and passive QQ group messages", async () => {
  const fake = new FakeBot();
  const channel = adapter(fake);
  const events: InboundChannelEvent[] = [];
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
    text: "done"
  };
  const receipt = await channel.sendText(delivery);
  assert.equal(receipt.outcome, "accepted");
  assert.equal(receipt.providerMessageId, "provider-result-1");
  assert.deepEqual(fake.sent[0]?.target, {
    scope: "c2c",
    targetId: "user-openid",
    msgId: "message-1"
  });

  fake.sendFailure = new ApiError("bad request", 400, "/messages");
  await assert.rejects(
    channel.sendText(delivery),
    (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "rejected"
  );
  fake.sendFailure = new Error("connection reset");
  await assert.rejects(
    channel.sendText(delivery),
    (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "ambiguous"
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
