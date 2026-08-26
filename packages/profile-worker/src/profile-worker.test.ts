import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  CodexAppServerOptions,
  JsonRpcErrorObject,
  JsonRpcId,
  ManagedCodexRpcRuntime,
  ProtocolProbeResult
} from "@codex-channel-bridge/codex-app-server";

import { ProfileWorker, type ProfileWorkerDependencies } from "./profile-worker.js";

const testedProbe: ProtocolProbeResult = {
  cliVersion: "0.149.1",
  verification: "tested",
  schemaSha256: "test",
  requiredMethods: []
};

class FakeRuntime extends EventEmitter implements ManagedCodexRpcRuntime {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  stopped = false;

  async start() {
    return {
      userAgent: "fake",
      platformFamily: "unix",
      platformOs: "macos",
      codexHome: "/tmp/codex-home"
    };
  }

  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    this.requests.push({ method, params });
    if (method === "model/list") return { data: [] } as TResult;
    if (method === "thread/start") return { thread: { id: "thread-1" } } as TResult;
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id: "item-1", text: "done" }
          }
        });
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
        });
      });
      return { turn: { id: "turn-1", status: "inProgress" } } as TResult;
    }
    throw new Error(`Unexpected method ${method}`);
  }

  async notify(): Promise<void> {}
  async respond(): Promise<void> {}
  async respondError(_id: JsonRpcId, _error: JsonRpcErrorObject): Promise<void> {}
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function dependencies(runtime: FakeRuntime): ProfileWorkerDependencies {
  return {
    probe: async () => testedProbe,
    createRuntime: (_options: CodexAppServerOptions) => runtime
  };
}

test("starts a Profile only after schema and live model probes pass", async () => {
  const runtime = new FakeRuntime();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home"
    },
    dependencies(runtime)
  );
  const health = await worker.start();
  assert.deepEqual(health, {
    profileId: "profile-a",
    readiness: "ready",
    reason: null,
    codexVersion: "0.149.1",
    codexVerification: "tested"
  });
  assert.equal(runtime.requests[0]?.method, "model/list");
  await worker.stop();
  assert.equal(runtime.stopped, true);
});

test("runs a minimal Thread and Turn without storing Codex history", async () => {
  const runtime = new FakeRuntime();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home"
    },
    dependencies(runtime)
  );
  await worker.start();
  const result = await worker.runTurn("answer briefly");
  assert.deepEqual(result, {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: "done"
  });
  assert.deepEqual(
    runtime.requests.map((request) => request.method),
    ["model/list", "thread/start", "turn/start"]
  );
  await worker.stop();
});

test("fails closed on a relative Workspace path", async () => {
  const runtime = new FakeRuntime();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "relative",
      codexHome: "/tmp/codex-home"
    },
    dependencies(runtime)
  );
  const health = await worker.start();
  assert.equal(health.readiness, "unavailable");
  assert.equal(health.reason, "invalid_profile_configuration");
});
