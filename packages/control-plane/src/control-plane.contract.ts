import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import test from "node:test";

import type { AdministrationHandler } from "./administration.js";
import { ControlPlaneClient } from "./client.js";
import { ControlPlaneServer, type RequestAuthorizer } from "./server.js";

test("serves one structured request per local IPC connection", async (context) => {
  const endpoint = await controlEndpoint(context);
  let authorizations = 0;
  const authorizer: RequestAuthorizer = {
    authorize: async () => {
      authorizations += 1;
      return "system_administrator";
    }
  };
  const handler: AdministrationHandler = {
    handle: async (request) => ({ method: request.method })
  };
  const server = new ControlPlaneServer({ endpoint, handler, authorizer });
  try {
    await server.start();
    if (process.platform !== "win32") assert.equal((await stat(endpoint)).mode & 0o777, 0o600);
    const client = new ControlPlaneClient(endpoint);
    assert.deepEqual(await client.request("status/get"), { method: "status/get" });
    assert.deepEqual(await client.request("status/get"), { method: "status/get" });
    assert.equal(authorizations, 2);
  } finally {
    await server.stop();
  }
});

test("streams pairing material only on its initiating control connection before the final result", async (context) => {
  const endpoint = await controlEndpoint(context);
  const handler: AdministrationHandler = {
    handle: async (_request, emitEvent) => {
      await emitEvent?.({
        kind: "pairing_material",
        material: { kind: "qr", value: "sensitive-test-qr", expiresAtMs: 123 }
      });
      return { kind: "paired", generationId: "generation-1" };
    }
  };
  const server = new ControlPlaneServer({ endpoint, handler });
  try {
    await server.start();
    const events: unknown[] = [];
    assert.deepEqual(
      await new ControlPlaneClient(endpoint).request(
        "whatsapp/pair",
        { profileId: "alpha", channelAccountId: "wa-primary" },
        (event) => {
          events.push(event);
        }
      ),
      { kind: "paired", generationId: "generation-1" }
    );
    assert.deepEqual(events, [{
      kind: "pairing_material",
      material: { kind: "qr", value: "sensitive-test-qr", expiresAtMs: 123 }
    }]);
  } finally {
    await server.stop();
  }
});

test("fails closed when per-request authorization denies access", async (context) => {
  const endpoint = await controlEndpoint(context);
  const server = new ControlPlaneServer({
    endpoint,
    handler: { handle: async () => ({}) },
    authorizer: { authorize: async () => null }
  });
  try {
    await server.start();
    const client = new ControlPlaneClient(endpoint);
    await assert.rejects(
      () => client.request("status/get"),
      (error: unknown) => error instanceof Error && error.message === "Operation is not authorized"
    );
  } finally {
    await server.stop();
  }
});

test("a second server cannot replace an active control socket", async (context) => {
  const endpoint = await controlEndpoint(context);
  const handler: AdministrationHandler = { handle: async () => ({}) };
  const first = new ControlPlaneServer({ endpoint, handler });
  const second = new ControlPlaneServer({ endpoint, handler });
  try {
    await first.start();
    await assert.rejects(() => second.start(), /already in use/);
    assert.deepEqual(await new ControlPlaneClient(endpoint).request("status/get"), {});
  } finally {
    await second.stop().catch(() => undefined);
    await first.stop();
  }
});

test("stop closes an idle control connection", async (context) => {
  const endpoint = await controlEndpoint(context);
  const server = new ControlPlaneServer({ endpoint, handler: { handle: async () => ({}) } });
  let socket: ReturnType<typeof createConnection> | undefined;
  try {
    await server.start();
    socket = createConnection({ path: endpoint });
    const connection = socket;
    await new Promise<void>((resolve, reject) => {
      connection.once("connect", resolve);
      connection.once("error", reject);
    });
    const disconnected = once(connection, "close");
    await server.stop();
    await disconnected;
    assert.equal(connection.destroyed, true);
  } finally {
    socket?.destroy();
    await server.stop().catch(() => undefined);
  }
});

async function controlEndpoint(context: test.TestContext): Promise<string> {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\codex-channel-bridge-test-${process.pid}-${randomUUID()}`;
  }
  const root = await mkdtemp(join(tmpdir(), "bridge-control-test-"));
  context.after(async () => rm(root, { force: true, recursive: true }));
  return join(root, "control.sock");
}
