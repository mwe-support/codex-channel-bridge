import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  AuthenticationState,
  WAMessage
} from "baileys";

import { ChannelDeliveryError, type ProviderInboundEvent } from "@codex-channel-bridge/core";

import {
  WhatsAppChannelAdapter,
  normalizeWhatsAppMessage,
  type AdapterSocket,
  type BaileysSocketConfiguration
} from "./whatsapp-adapter.js";

class FakeSocket {
  readonly emitter = new EventEmitter();
  readonly ev = this.emitter as unknown as AdapterSocket["ev"];
  readonly user = {
    id: "15550000000:1@s.whatsapp.net",
    lid: "123456789012345@lid"
  };
  readonly sends: Array<{ jid: string; content: unknown; options?: unknown }> = [];
  ended = false;
  logoutCount = 0;
  logoutFailure = false;
  readonly presence: Array<{ type: string; jid: string }> = [];
  presenceWait: Promise<void> | undefined;
  presenceFailure = false;

  async sendPresenceUpdate(type: "composing" | "paused", jid: string): Promise<void> {
    this.presence.push({ type, jid });
    if (this.presenceFailure) throw new Error("presence rejected");
    await this.presenceWait;
  }

  async sendMessage(jid: string, content: unknown, options?: unknown): Promise<WAMessage> {
    this.sends.push({ jid, content, ...(options ? { options } : {}) });
    return { key: { id: `out-${this.sends.length}` } } as WAMessage;
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  async logout(): Promise<void> {
    this.logoutCount += 1;
    if (this.logoutFailure) throw new Error("logout failed");
  }
}

const auth = {} as AuthenticationState;

test("WhatsApp sends document bytes to the original private or group target with quote correlation", async () => {
  const socket = new FakeSocket();
  const adapter = new WhatsAppChannelAdapter({ channelAccountId: "wa", auth, saveCredentials: async () => {} }, () => socket);
  const started = adapter.start(async () => {});
  socket.emitter.emit("connection.update", { connection: "open" });
  await started;
  try {
    for (const conversationKind of ["private", "group"] as const) {
      const target = { conversationKey: "conversation", conversationKind,
        providerConversationId: conversationKind === "private" ? "user@lid" : "group@g.us",
        providerReplyEventId: "inbound", providerReplyParticipantId: "sender@lid", providerReplyText: "generate file" };
      const receipt = await adapter.sendFile({ logicalResultId: "file-result", segmentIndex: 1,
        target, filename: "report.txt", bytes: Buffer.from("test") });
      assert.equal(receipt.outcome, "accepted");
      assert.equal(socket.sends.at(-1)!.jid, target.providerConversationId);
      assert.deepEqual(socket.sends.at(-1)!.content, { document: Buffer.from("test"), mimetype: "application/octet-stream", fileName: "report.txt" });
      assert.ok(socket.sends.at(-1)!.options);
    }
    const delivery = { logicalResultId: "file-result", segmentIndex: 1,
      target: { conversationKey: "conversation", conversationKind: "private" as const,
        providerConversationId: "user@lid" }, filename: "report.txt", bytes: Buffer.from("test") };
    const send = socket.sendMessage.bind(socket);
    socket.sendMessage = async () => { throw new Error("upload or send response lost"); };
    await assert.rejects(adapter.sendFile(delivery),
      (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "ambiguous");
    socket.sendMessage = async () => ({ key: {} }) as WAMessage;
    await assert.rejects(adapter.sendFile(delivery),
      (error: unknown) => error instanceof ChannelDeliveryError && error.outcome === "ambiguous");
    socket.sendMessage = send;
    assert.equal((await adapter.sendFile(delivery)).outcome, "accepted");
  } finally { await adapter.stop(); }
});

test("typing starts immediately, refreshes without text and shares overlapping group Turns", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const socket = new FakeSocket();
  const adapter = new WhatsAppChannelAdapter({ channelAccountId: "wa", auth, saveCredentials: async () => {} }, () => socket);
  const started = adapter.start(async () => {});
  socket.emitter.emit("connection.update", { connection: "open" });
  await started;
  const target = { conversationKey: "group", conversationKind: "group" as const, providerConversationId: "group@g.us" };
  const stopA = adapter.startTyping(target)!;
  const stopB = adapter.startTyping(target)!;
  const stopPrivate = adapter.startTyping({ ...target, conversationKey: "private", conversationKind: "private", providerConversationId: "user@lid" })!;
  assert.deepEqual(socket.presence, [
    { type: "composing", jid: "group@g.us" }, { type: "composing", jid: "user@lid" }
  ]);
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 6; j++) await Promise.resolve();
    t.mock.timers.tick(5_000);
  }
  assert.equal(socket.presence.filter((entry) => entry.type === "composing").length, 28);
  assert.equal(socket.sends.length, 0);
  for (let j = 0; j < 6; j++) await Promise.resolve();
  stopA(); stopA();
  assert.equal(socket.presence.filter((entry) => entry.type === "paused").length, 0);
  stopB(); stopPrivate();
  await Promise.resolve();
  assert.deepEqual(socket.presence.slice(-2), [
    { type: "paused", jid: "group@g.us" }, { type: "paused", jid: "user@lid" }
  ]);
  const count = socket.presence.length;
  t.mock.timers.tick(60_000);
  assert.equal(socket.presence.length, count);
  await adapter.sendText({ target, logicalResultId: "final", segmentIndex: 0, text: "complete final text" });
  assert.deepEqual(socket.sends.map((send) => send.content), [{ text: "complete final text" }]);
  await adapter.stop();
});

test("typing rejection, in-flight cleanup and old sockets cannot affect final delivery", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  const adapter = new WhatsAppChannelAdapter({
    channelAccountId: "wa", auth, saveCredentials: async () => {}, reconnectDelaysMs: [0]
  }, () => sockets.shift()!);
  const started = adapter.start(async () => {});
  first.emitter.emit("connection.update", { connection: "open" });
  await started;
  const target = { conversationKey: "private", conversationKind: "private" as const, providerConversationId: "user@lid" };
  let resolveSend!: () => void;
  first.presenceWait = new Promise<void>((resolve) => { resolveSend = resolve; });
  const stop = adapter.startTyping(target)!;
  t.mock.timers.tick(60_000);
  assert.equal(first.presence.length, 1); // A stalled call cannot build a send queue.
  stop();
  assert.equal(first.presence.length, 1);
  resolveSend();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(first.presence.at(-1)?.type, "paused");
  first.presenceWait = undefined;

  first.presenceFailure = true;
  adapter.startTyping(target);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const failedCount = first.presence.length;
  t.mock.timers.tick(60_000);
  assert.equal(first.presence.length, failedCount);
  await adapter.sendText({ target, logicalResultId: "final", segmentIndex: 0, text: "final after presence rejection" });
  assert.equal(first.sends.length, 1);

  first.presenceFailure = false;
  first.presenceWait = new Promise<void>((resolve) => { resolveSend = resolve; });
  const staleStop = adapter.startTyping(target)!;
  first.emitter.emit("connection.update", { connection: "close" });
  await Promise.resolve();
  second.emitter.emit("connection.update", { connection: "open" });
  const currentStop = adapter.startTyping(target)!;
  const before = first.presence.length;
  resolveSend();
  staleStop();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  t.mock.timers.tick(5_000);
  assert.equal(first.presence.length, before);
  assert.equal(second.presence.filter((entry) => entry.type === "composing").length, 2);
  await Promise.resolve();
  currentStop();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(second.presence.at(-1)?.type, "paused");
  assert.throws(() => adapter.startTyping({ ...target, providerConversationId: "invalid" }));
  const stops = Array.from({ length: 64 }, (_, index) => adapter.startTyping({
    ...target, providerConversationId: `user${index}@lid`
  })!);
  assert.equal(adapter.startTyping({ ...target, providerConversationId: "overflow@lid" }), undefined);
  await adapter.stop();
  for (const cleanup of stops) cleanup();
  const stoppedCount = second.presence.length;
  t.mock.timers.tick(60_000);
  assert.equal(second.presence.length, stoppedCount);
  assert.equal(adapter.startTyping(target), undefined);
});

test("starts with history disabled and accepts only live non-resend messages", async () => {
  const socket = new FakeSocket();
  let config: BaileysSocketConfiguration | undefined;
  const adapter = new WhatsAppChannelAdapter(
    {
      channelAccountId: "wa-primary",
      auth,
      saveCredentials: async () => undefined
    },
    (value) => {
      config = value;
      return socket as unknown as AdapterSocket;
    }
  );
  const events: ProviderInboundEvent[] = [];
  const started = adapter.start(async (event) => { events.push(event); });
  socket.emitter.emit("connection.update", { connection: "open" });
  await started;
  assert.equal(adapter.readiness(), "ready");
  assert.equal(config?.syncFullHistory, false);
  assert.equal(config?.shouldSyncHistoryMessage?.(), false);

  const message = privateMessage("in-1", "hello");
  socket.emitter.emit("messages.upsert", { type: "append", messages: [message] });
  socket.emitter.emit("messages.upsert", {
    type: "notify",
    requestId: "placeholder-resend",
    messages: [message]
  });
  socket.emitter.emit("messages.upsert", { type: "notify", messages: [message] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.message.text, "hello");
  await adapter.stop();
  assert.equal(socket.ended, true);
});

test("normalizes private and mentioned group messages with provider-owned identities", () => {
  const direct = normalizeWhatsAppMessage(privateMessage("in-1", "hello"), undefined, 9_000);
  assert.equal(direct?.message.provider, "whatsapp");
  assert.equal(direct?.message.conversationKind, "private");
  assert.equal(direct?.message.providerIdentity, "15551112222@s.whatsapp.net");
  assert.equal(direct?.message.observedAtMs, 1_000);
  assert.equal(direct?.attention, "direct");

  const group = normalizeWhatsAppMessage({
    key: {
      id: "group-1",
      remoteJid: "120363000000000000@g.us",
      participant: "15553334444:7@s.whatsapp.net"
    },
    messageTimestamp: 2,
    message: {
      extendedTextMessage: {
        text: "@bridge please help",
        contextInfo: { mentionedJid: ["15550000000@s.whatsapp.net"] }
      }
    }
  } as WAMessage, "15550000000:1@s.whatsapp.net", 9_000);
  assert.equal(group?.message.conversationKind, "group");
  assert.equal(group?.message.providerIdentity, "15553334444@s.whatsapp.net");
  assert.equal(group?.attention, "mention");

  const lidMention = normalizeWhatsAppMessage({
    key: {
      id: "group-2",
      remoteJid: "120363000000000000@g.us",
      participant: "15553334444@s.whatsapp.net"
    },
    messageTimestamp: 3,
    message: {
      extendedTextMessage: {
        text: "@bridge please help",
        contextInfo: { mentionedJid: ["123456789012345@lid"] }
      }
    }
  } as WAMessage, ["15550000000:1@s.whatsapp.net", "123456789012345@lid"], 9_000);
  assert.equal(lidMention?.attention, "mention");
});

test("exposes one-shot Baileys decrypted media as a bounded stream source", async () => {
  let downloads = 0;
  const event = normalizeWhatsAppMessage({
    ...privateMessage("media-1", "caption"),
    message: {
      imageMessage: {
        caption: "caption",
        mimetype: "image/jpeg",
        fileLength: 3,
        width: 10,
        height: 20,
        mediaKey: new Uint8Array([1]),
        directPath: "/media",
        url: "https://example.invalid/media"
      }
    }
  } as WAMessage, undefined, 9_000, async () => {
    downloads += 1;
    return (async function* () { yield new Uint8Array([1, 2, 3]); })();
  });
  assert.equal(event?.attachments?.[0]?.contentType, "image/jpeg");
  assert.equal(event?.attachments?.[0]?.declaredSizeBytes, 3);
  const source = event?.attachments?.[0]?.contentSource;
  assert.ok(source);
  const chunks: number[] = [];
  for await (const chunk of await source.openStream()) chunks.push(...chunk);
  assert.deepEqual(chunks, [1, 2, 3]);
  assert.equal(downloads, 1);
  await assert.rejects(source.openStream(), /already opened/u);
});

test("maps a successful WhatsApp send to the Channel delivery receipt", async () => {
  const socket = new FakeSocket();
  const adapter = new WhatsAppChannelAdapter(
    {
      channelAccountId: "wa-primary",
      auth,
      saveCredentials: async () => undefined
    },
    () => socket as unknown as AdapterSocket
  );
  const started = adapter.start(async () => undefined);
  socket.emitter.emit("connection.update", { connection: "open" });
  await started;
  const receipt = await adapter.sendText({
    logicalResultId: "result-1",
    segmentIndex: 0,
    target: {
      conversationKey: "whatsapp:wa-primary:private:15551112222@s.whatsapp.net",
      conversationKind: "private",
      providerConversationId: "15551112222@s.whatsapp.net"
    },
    text: "done"
  });
  assert.equal(receipt.providerMessageId, "out-1");
  assert.deepEqual(socket.sends, [
    { jid: "15551112222@s.whatsapp.net", content: { text: "done" } }
  ]);
  await adapter.stop();
});

test("reconstructs a durable WhatsApp group quote from channel-neutral reply facts", async () => {
  const socket = new FakeSocket();
  const adapter = new WhatsAppChannelAdapter(
    {
      channelAccountId: "wa-primary",
      auth,
      saveCredentials: async () => undefined
    },
    () => socket as unknown as AdapterSocket
  );
  const started = adapter.start(async () => undefined);
  socket.emitter.emit("connection.update", { connection: "open" });
  await started;
  await adapter.sendText({
    logicalResultId: "result-quote",
    segmentIndex: 0,
    target: {
      conversationKey: "whatsapp:wa-primary:group:120363000000000000@g.us",
      conversationKind: "group",
      providerConversationId: "120363000000000000@g.us",
      providerReplyEventId: "in-1",
      providerReplyParticipantId: "15553334444@s.whatsapp.net",
      providerReplyText: "original message"
    },
    text: "reply"
  });
  assert.deepEqual(socket.sends[0], {
    jid: "120363000000000000@g.us",
    content: { text: "reply" },
    options: {
      quoted: {
        key: {
          id: "in-1",
          remoteJid: "120363000000000000@g.us",
          fromMe: false,
          participant: "15553334444@s.whatsapp.net"
        },
        participant: "15553334444@s.whatsapp.net",
        message: { conversation: "original message" }
      }
    }
  });
  await adapter.stop();
});

test("reconnects a closed live socket and ignores stale socket events", async () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  const events: ProviderInboundEvent[] = [];
  const adapter = new WhatsAppChannelAdapter(
    {
      channelAccountId: "wa-primary",
      auth,
      saveCredentials: async () => undefined,
      reconnectDelaysMs: [0]
    },
    () => sockets.shift() as unknown as AdapterSocket
  );
  const started = adapter.start(async (event) => { events.push(event); });
  first.emitter.emit("connection.update", { connection: "open" });
  await started;
  first.emitter.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 428 } } }
  });
  await waitUntil(() => sockets.length === 0);
  second.emitter.emit("connection.update", { connection: "open" });
  assert.equal(adapter.readiness(), "ready");

  first.emitter.emit("messages.upsert", {
    type: "notify",
    messages: [privateMessage("stale", "ignored")]
  });
  second.emitter.emit("messages.upsert", {
    type: "notify",
    messages: [privateMessage("current", "accepted")]
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event.message.text), ["accepted"]);
  await adapter.stop();
});

test("does not reconnect after a non-retryable logout", async () => {
  const socket = new FakeSocket();
  let socketCount = 0;
  const adapter = new WhatsAppChannelAdapter(
    {
      channelAccountId: "wa-primary",
      auth,
      saveCredentials: async () => undefined,
      reconnectDelaysMs: [0, 0]
    },
    () => {
      socketCount += 1;
      return socket as unknown as AdapterSocket;
    }
  );
  const started = adapter.start(async () => undefined);
  socket.emitter.emit("connection.update", { connection: "open" });
  await started;
  socket.emitter.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socketCount, 1);
  assert.equal(adapter.readiness(), "degraded");
  await adapter.stop();
});

test("bounds retryable reconnect attempts", async () => {
  const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
  let socketCount = 0;
  const adapter = new WhatsAppChannelAdapter(
    {
      channelAccountId: "wa-primary",
      auth,
      saveCredentials: async () => undefined,
      reconnectDelaysMs: [0, 0]
    },
    () => {
      const socket = sockets[socketCount];
      socketCount += 1;
      if (!socket) throw new Error("unexpected socket creation");
      return socket as unknown as AdapterSocket;
    }
  );
  const started = adapter.start(async () => undefined);
  sockets[0]!.emitter.emit("connection.update", { connection: "open" });
  await started;
  for (let index = 0; index < sockets.length; index += 1) {
    sockets[index]!.emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } }
    });
    if (index < sockets.length - 1) {
      await waitUntil(() => socketCount === index + 2);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socketCount, 3);
  assert.equal(adapter.readiness(), "degraded");
  await adapter.stop();
});

test("reports a sent logout request as uncertain without reconnecting", async () => {
  const socket = new FakeSocket();
  const adapter = new WhatsAppChannelAdapter(
    {
      channelAccountId: "wa-primary",
      auth,
      saveCredentials: async () => undefined,
      reconnectDelaysMs: [0]
    },
    () => socket as unknown as AdapterSocket
  );
  const started = adapter.start(async () => undefined);
  socket.emitter.emit("connection.update", { connection: "open" });
  await started;
  assert.equal(await adapter.requestLogout(), "uncertain");
  assert.equal(socket.logoutCount, 1);
  assert.equal(adapter.readiness(), "degraded");
  socket.emitter.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 428 } } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.logoutCount, 1);
  await adapter.stop();
});

function privateMessage(id: string, text: string): WAMessage {
  return {
    key: { id, remoteJid: "15551112222:3@s.whatsapp.net" },
    messageTimestamp: 1,
    message: { conversation: text }
  } as WAMessage;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
