import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdministrationHandler } from "./administration.js";
import { ControlPlaneClient } from "./client.js";
import { ControlPlaneServer, type RequestAuthorizer } from "./server.js";

test("serves one structured request per owner-only Unix socket connection", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket permission assertion");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "bridge-control-test-"));
  const endpoint = join(root, "control.sock");
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
    assert.equal((await stat(endpoint)).mode & 0o777, 0o600);
    const client = new ControlPlaneClient(endpoint);
    assert.deepEqual(await client.request("status/get"), { method: "status/get" });
    assert.deepEqual(await client.request("status/get"), { method: "status/get" });
    assert.equal(authorizations, 2);
  } finally {
    await server.stop();
    await rm(root, { force: true, recursive: true });
  }
});

test("fails closed when per-request authorization denies access", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket test");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "bridge-control-test-"));
  const endpoint = join(root, "control.sock");
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
    await rm(root, { force: true, recursive: true });
  }
});

test("a second server cannot replace an active control socket", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket test");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "bridge-control-test-"));
  const endpoint = join(root, "control.sock");
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
    await rm(root, { force: true, recursive: true });
  }
});
