import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AuthenticationState, WAMessage } from "baileys";

import {
  activateBaileysAuthGeneration,
  createStagedBaileysAuthState,
  markBaileysAuthRevocationUncertain,
  readBaileysAuthRevocationState
} from "./baileys-auth-state.js";
import type { AdapterSocket } from "./whatsapp-adapter.js";
import type { WhatsAppPairingSocket } from "./whatsapp-pairing.js";
import {
  WhatsAppChannelAccount,
  type WhatsAppChannelAccountEvent
} from "./whatsapp-channel-account.js";

class FakeRuntimeSocket {
  readonly emitter = new EventEmitter();
  readonly ev = this.emitter as unknown as AdapterSocket["ev"];
  readonly user = { id: "15551112222:1@s.whatsapp.net" };
  ended = false;
  logoutCount = 0;

  async sendMessage(): Promise<WAMessage> {
    return { key: { id: "out-1" } } as WAMessage;
  }

  async logout(): Promise<void> {
    this.logoutCount += 1;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

class FakePairingSocket {
  readonly emitter = new EventEmitter();
  readonly ev = this.emitter as unknown as WhatsAppPairingSocket["ev"];
  user?: { id?: string | null };

  async end(): Promise<void> {}
}

test("pairs a missing account and replaces only its inner Adapter", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-whatsapp-account-pair-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  const pairingSocket = new FakePairingSocket();
  const runtimeSockets: FakeRuntimeSocket[] = [];
  const events: WhatsAppChannelAccountEvent[] = [];
  let pairingAuth: AuthenticationState | undefined;
  const account = new WhatsAppChannelAccount({
    channelAccountId: "wa-primary",
    rootDirectoryPath,
    pairingSocketFactory: (config) => {
      pairingAuth = config.auth as AuthenticationState;
      return pairingSocket;
    },
    socketFactory: () => {
      const socket = new FakeRuntimeSocket();
      runtimeSockets.push(socket);
      return socket as unknown as AdapterSocket;
    }
  });
  try {
    await account.start(async () => undefined);
    assert.equal(account.readiness(), "degraded");
    const pairing = account.execute(
      { kind: "pair", timeoutMs: 1_000 },
      (event) => { events.push(event); }
    );
    await waitUntil(() => pairingAuth !== undefined);
    pairingSocket.emitter.emit("connection.update", { qr: "short-lived-qr" });
    pairingAuth!.creds.registered = true;
    pairingSocket.user = { id: "15551112222:4@s.whatsapp.net" };
    pairingSocket.emitter.emit("connection.update", { connection: "open" });
    await waitUntil(() => runtimeSockets.length === 1);
    runtimeSockets[0]!.emitter.emit("connection.update", { connection: "open" });
    const result = await pairing;
    assert.equal(result.kind, "paired");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "pairing_material");
    assert.equal(account.readiness(), "ready");

    assert.deepEqual(await account.execute({ kind: "disconnect" }), {
      kind: "disconnected"
    });
    assert.equal(account.readiness(), "degraded");
    const reconnect = account.execute({ kind: "connect" });
    await waitUntil(() => runtimeSockets.length === 2);
    runtimeSockets[1]!.emitter.emit("connection.update", { connection: "open" });
    assert.deepEqual(await reconnect, { kind: "connected" });
  } finally {
    await account.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("persists logout uncertainty and blocks ordinary reconnect", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-whatsapp-account-logout-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  await prepareRegisteredAuth(rootDirectoryPath);
  const socket = new FakeRuntimeSocket();
  let socketCreated = false;
  const account = new WhatsAppChannelAccount({
    channelAccountId: "wa-primary",
    rootDirectoryPath,
    socketFactory: () => {
      socketCreated = true;
      return socket as unknown as AdapterSocket;
    }
  });
  try {
    const started = account.start(async () => undefined);
    await waitUntil(() => socketCreated);
    socket.emitter.emit("connection.update", { connection: "open" });
    await started;
    assert.deepEqual(await account.execute({ kind: "logout" }), {
      kind: "logout_uncertain"
    });
    assert.equal(socket.logoutCount, 1);
    assert.equal(await readBaileysAuthRevocationState({ rootDirectoryPath }), "uncertain");
    await assert.rejects(account.execute({ kind: "connect" }), /revocation is uncertain/);
  } finally {
    await account.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("requires exact confirmation before forgetting only local auth", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-whatsapp-account-forget-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  await prepareRegisteredAuth(rootDirectoryPath);
  const socket = new FakeRuntimeSocket();
  let socketCreated = false;
  const account = new WhatsAppChannelAccount({
    channelAccountId: "wa-primary",
    rootDirectoryPath,
    socketFactory: () => {
      socketCreated = true;
      return socket as unknown as AdapterSocket;
    }
  });
  try {
    const started = account.start(async () => undefined);
    await waitUntil(() => socketCreated);
    socket.emitter.emit("connection.update", { connection: "open" });
    await started;
    await assert.rejects(
      account.execute({ kind: "forget_local", confirmChannelAccountId: "wrong" }),
      /confirmation did not match/
    );
    await assert.rejects(
      account.execute({ kind: "forget_local", confirmChannelAccountId: "wa-primary" }),
      /only after uncertain revocation/
    );
    assert.equal((await lstat(rootDirectoryPath)).isDirectory(), true);
    await markBaileysAuthRevocationUncertain({ rootDirectoryPath });
    assert.deepEqual(
      await account.execute({
        kind: "forget_local",
        confirmChannelAccountId: "wa-primary"
      }),
      { kind: "local_auth_forgotten" }
    );
    await assert.rejects(lstat(rootDirectoryPath), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  } finally {
    await account.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

async function prepareRegisteredAuth(rootDirectoryPath: string): Promise<void> {
  const generation = await createStagedBaileysAuthState({ rootDirectoryPath });
  const state = generation.state as AuthenticationState;
  state.creds.registered = true;
  state.creds.me = { id: "15551112222:1@s.whatsapp.net", name: "test" };
  await generation.saveCredentials();
  await activateBaileysAuthGeneration({
    rootDirectoryPath,
    generationId: generation.generationId
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}
