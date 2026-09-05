import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  JsonRpcErrorObject,
  JsonRpcId,
  ManagedCodexRpcRuntime
} from "@codex-channel-bridge/codex-app-server";

import {
  CodexServerRequestRouter,
  type ApprovalControllerContext
} from "./codex-server-request-router.js";

class FakeRuntime extends EventEmitter implements ManagedCodexRpcRuntime {
  readonly responses: Array<{ id: JsonRpcId; result: unknown }> = [];
  readonly errors: Array<{ id: JsonRpcId; error: JsonRpcErrorObject }> = [];
  responseFailure?: Error;
  async start() {
    return { userAgent: "fake", platformFamily: "unix", platformOs: "macos", codexHome: "/tmp" };
  }
  async request<TResult>(): Promise<TResult> { throw new Error("not used"); }
  async notify(): Promise<void> {}
  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    if (this.responseFailure) throw this.responseFailure;
    this.responses.push({ id, result });
  }
  async respondError(id: JsonRpcId, error: JsonRpcErrorObject): Promise<void> {
    this.errors.push({ id, error });
  }
  async stop(): Promise<void> {}
}

const controller: ApprovalControllerContext = {
  profileId: "alpha",
  channelAccountId: "qq-primary",
  channelAccountEpochId: "epoch-1",
  conversationKey: "qq:qq-primary:private:user-1",
  providerIdentity: "user-1",
  replyTarget: {
    conversationKey: "qq:qq-primary:private:user-1",
    conversationKind: "private",
    providerConversationId: "user-1"
  }
};

test("routes a stable Approval Request to its Turn initiator and responds on the original id", async () => {
  const runtime = new FakeRuntime();
  const router = new CodexServerRequestRouter(runtime, {
    newApprovalToken: () => "approval-1"
  });
  const disposition = await router.accept(
    {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1 }
    },
    (threadId, turnId) => threadId === "thread-1" && turnId === "turn-1" ? controller : undefined
  );
  assert.equal(disposition.kind, "approval");
  assert.equal(disposition.kind === "approval" && disposition.approval.approvalToken, "approval-1");
  assert.equal(router.pendingCount(), 1);

  await assert.rejects(
    router.respond(7, { ...controller, providerIdentity: "user-2" }, "accept"),
    /does not control/
  );
  await router.respondByToken("approval-1", controller, "decline");
  assert.deepEqual(runtime.responses, [{ id: 7, result: { decision: "decline" } }]);
  assert.equal(router.pendingCount(), 0);
});

test("keeps the opaque token pending when writing the native response fails", async () => {
  const runtime = new FakeRuntime();
  const router = new CodexServerRequestRouter(runtime, {
    newApprovalToken: () => "approval-retry"
  });
  await router.accept(
    {
      id: 8,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" }
    },
    () => controller
  );
  runtime.responseFailure = new Error("write failed");
  await assert.rejects(
    router.respondByToken("approval-retry", controller, "accept"),
    /write failed/
  );
  assert.equal(router.pendingCount(), 1);
  runtime.responseFailure = undefined;
  await router.respondByToken("approval-retry", controller, "decline");
  assert.deepEqual(runtime.responses, [{ id: 8, result: { decision: "decline" } }]);
});

test("cancels a pending Approval Request when its Channel response window expires", async () => {
  const runtime = new FakeRuntime();
  let expiredToken = "";
  const router = new CodexServerRequestRouter(runtime, {
    approvalTimeoutMs: 10,
    newApprovalToken: () => "approval-timeout",
    onExpired: (approval) => {
      expiredToken = approval.approvalToken;
    }
  });
  await router.accept(
    {
      id: "timeout-request",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" }
    },
    () => controller
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(expiredToken, "approval-timeout");
  assert.deepEqual(runtime.responses, [
    { id: "timeout-request", result: { decision: "cancel" } }
  ]);
});

test("fails unsupported and uncontrolled requests closed", async () => {
  const runtime = new FakeRuntime();
  const router = new CodexServerRequestRouter(runtime);
  assert.deepEqual(
    await router.accept({ id: "a", method: "item/tool/requestUserInput", params: {} }, () => controller),
    { kind: "rejected", reason: "unsupported" }
  );
  assert.deepEqual(
    await router.accept(
      {
        id: "b",
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1" }
      },
      () => undefined
    ),
    { kind: "rejected", reason: "uncontrolled" }
  );
  assert.deepEqual(runtime.errors.map((entry) => entry.error.code), [-32601, -32602]);
});

test("native resolution invalidates only the matching Thread and typed request id", async () => {
  const runtime = new FakeRuntime();
  let sequence = 0;
  const router = new CodexServerRequestRouter(runtime, { newApprovalToken: () => `token-${++sequence}` });
  for (const id of [7, "7"]) {
    await router.accept({ id, method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" } }, () => controller);
  }
  assert.equal(router.resolveNotification({ method: "serverRequest/resolved",
    params: { threadId: "other", requestId: 7 } }).length, 0);
  assert.equal(router.resolveNotification({ method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: 7 } }).length, 1);
  await assert.rejects(router.respondByToken("token-1", controller, "accept"), /not pending/);
  assert.equal(router.pendingCount(), 1);
  assert.equal(runtime.responses.length, 0);
  assert.equal(router.resolveNotification({ method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "other", status: "interrupted" } } }).length, 0);
  assert.equal(router.resolveNotification({ method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } }).length, 1);
  assert.equal(router.pendingCount(), 0);
  await assert.rejects(router.respondByToken("token-2", controller, "accept"), /not pending/);
  assert.equal(runtime.responses.length, 0);
  router.close();
});

test("all participant boundaries, duplicate decisions and closed generations fail closed", async () => {
  const runtime = new FakeRuntime();
  const router = new CodexServerRequestRouter(runtime);
  const accepted = await router.accept({ id: 1, method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1" } }, () => controller);
  assert.equal(accepted.kind, "approval");
  if (accepted.kind !== "approval") return;
  const token = accepted.approval.approvalToken;
  for (const field of ["profileId", "channelAccountId", "channelAccountEpochId", "conversationKey", "providerIdentity"]) {
    await assert.rejects(router.respondByToken(token, { ...controller, [field]: "other" }, "accept"), /does not control/);
  }
  await router.respondByToken(token, controller, "decline");
  await assert.rejects(router.respondByToken(token, controller, "accept"), /not pending/);
  assert.equal(runtime.responses.length, 1);
  const pending = await router.accept({ id: 2, method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-2" } }, () => controller);
  router.close();
  if (pending.kind === "approval") {
    await assert.rejects(router.respondByToken(pending.approval.approvalToken, controller, "accept"), /not pending/);
  }
  assert.equal(runtime.responses.length, 1);
});

test("a response write failing during shutdown cannot resurrect an old-generation token", async () => {
  const runtime = new FakeRuntime();
  const router = new CodexServerRequestRouter(runtime, { newApprovalToken: () => "old-generation" });
  await router.accept({ id: 1, method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1" } }, () => controller);
  runtime.respond = async () => { router.close(); throw new Error("closed during write"); };
  await assert.rejects(router.respondByToken("old-generation", controller, "accept"), /closed during write/);
  assert.equal(router.pendingCount(), 0);
  await assert.rejects(router.respondByToken("old-generation", controller, "accept"), /not pending/);
  const late = await router.accept({ id: 2, method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1" } }, () => controller);
  assert.equal(late.kind, "rejected");
  assert.equal(router.pendingCount(), 0);
});
