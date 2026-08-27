import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AuthenticationState } from "baileys";

import { openActiveBaileysAuthState } from "./baileys-auth-state.js";
import {
  pairWhatsAppAccount,
  type WhatsAppPairingMaterial,
  type WhatsAppPairingSocket,
  type WhatsAppPairingSocketFactory
} from "./whatsapp-pairing.js";

class FakePairingSocket {
  readonly emitter = new EventEmitter();
  readonly ev = this.emitter as unknown as WhatsAppPairingSocket["ev"];
  user?: { id?: string | null };
  ended = false;

  async end(): Promise<void> {
    this.ended = true;
  }
}

test("presents QR material, proves identity, and activates staged auth", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-whatsapp-pairing-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  const socket = new FakePairingSocket();
  const materials: WhatsAppPairingMaterial[] = [];
  let auth: AuthenticationState | undefined;
  try {
    const pairing = pairWhatsAppAccount({
      rootDirectoryPath,
      timeoutMs: 1_000,
      pairingMaterialLifetimeMs: 1_000,
      now: () => 10_000,
      onPairingMaterial: (material) => { materials.push(material); },
      socketFactory: (config) => {
        auth = config.auth as AuthenticationState;
        return socket;
      }
    });
    await waitUntil(() => auth !== undefined);
    socket.emitter.emit("connection.update", { qr: "short-lived-qr" });
    auth!.creds.registered = true;
    socket.emitter.emit("creds.update", {});
    socket.user = { id: "15551112222:4@s.whatsapp.net" };
    socket.emitter.emit("connection.update", { connection: "open" });

    const result = await pairing;
    assert.deepEqual(materials, [{
      kind: "qr",
      value: "short-lived-qr",
      expiresAtMs: 11_000
    }]);
    assert.equal(result.providerIdentity, "15551112222@s.whatsapp.net");
    assert.equal(result.previousGenerationId, null);
    assert.equal(
      (await openActiveBaileysAuthState({ rootDirectoryPath })).generationId,
      result.generationId
    );
    assert.equal(socket.ended, true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("fails closed on Provider Identity mismatch and discards staged auth", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-whatsapp-pairing-mismatch-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  const socket = new FakePairingSocket();
  let auth: AuthenticationState | undefined;
  try {
    const pairing = pairWhatsAppAccount({
      rootDirectoryPath,
      expectedProviderIdentity: "15550000000@s.whatsapp.net",
      timeoutMs: 1_000,
      onPairingMaterial: () => undefined,
      socketFactory: (config) => {
        auth = config.auth as AuthenticationState;
        return socket;
      }
    });
    await waitUntil(() => auth !== undefined);
    auth!.creds.registered = true;
    socket.user = { id: "15559999999@s.whatsapp.net" };
    socket.emitter.emit("connection.update", { connection: "open" });
    await assert.rejects(pairing, /Identity did not match/);
    await assert.rejects(
      openActiveBaileysAuthState({ rootDirectoryPath }),
      /generation is missing/
    );
    assert.deepEqual(await readdir(join(rootDirectoryPath, "generations")), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("recreates the pairing Socket for bounded restartRequired", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-whatsapp-pairing-restart-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  const sockets = [new FakePairingSocket(), new FakePairingSocket()];
  const created: FakePairingSocket[] = [];
  let auth: AuthenticationState | undefined;
  const factory: WhatsAppPairingSocketFactory = (config) => {
    auth = config.auth as AuthenticationState;
    const socket = sockets[created.length];
    if (!socket) throw new Error("unexpected Socket creation");
    created.push(socket);
    return socket;
  };
  try {
    const pairing = pairWhatsAppAccount({
      rootDirectoryPath,
      timeoutMs: 1_000,
      onPairingMaterial: () => undefined,
      socketFactory: factory
    });
    await waitUntil(() => created.length === 1);
    created[0]!.emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } }
    });
    await waitUntil(() => created.length === 2);
    auth!.creds.registered = true;
    created[1]!.user = { id: "15551112222@s.whatsapp.net" };
    created[1]!.emitter.emit("connection.update", { connection: "open" });
    assert.equal((await pairing).providerIdentity, "15551112222@s.whatsapp.net");
    assert.equal(created[1]!.ended, true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}
