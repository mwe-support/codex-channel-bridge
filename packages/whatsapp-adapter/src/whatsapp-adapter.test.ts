import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  AuthenticationState,
  WAMessage
} from "baileys";

import type { ProviderInboundEvent } from "@codex-channel-bridge/core";

import {
  WhatsAppChannelAdapter,
  normalizeWhatsAppMessage,
  type AdapterSocket,
  type BaileysSocketConfiguration
} from "./whatsapp-adapter.js";

class FakeSocket {
  readonly emitter = new EventEmitter();
  readonly ev = this.emitter as unknown as AdapterSocket["ev"];
  readonly user = { id: "15550000000:1@s.whatsapp.net" };
  readonly sends: Array<{ jid: string; content: unknown; options?: unknown }> = [];
  ended = false;
  logoutCount = 0;
  logoutFailure = false;

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
