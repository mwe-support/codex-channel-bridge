import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  JsonRpcErrorObject,
  JsonRpcId,
  ManagedCodexRpcRuntime
} from "@codex-channel-bridge/codex-app-server";
import { CodexEventRouter } from "./codex-event-router.js";
import { TurnCoordinator } from "./turn-coordinator.js";

class FakeRuntime extends EventEmitter implements ManagedCodexRpcRuntime {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  completeTurns = true;
  #threadSequence = 0;

  public constructor(private readonly router: CodexEventRouter) {
    super();
  }

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
    if (method === "thread/start") {
      this.#threadSequence += 1;
      return { thread: { id: `thread-${this.#threadSequence}` } } as TResult;
    }
    if (method === "thread/resume") {
      return { thread: { id: (params as { threadId: string }).threadId } } as TResult;
    }
    if (method === "turn/start") {
      const input = params as { threadId: string };
      const turnId = `turn-for-${input.threadId}`;
      if (this.completeTurns) {
        // Deliberately route before returning the response to cover the JSON-RPC
        // response/notification race.
        this.router.route({
          method: "item/completed",
          params: {
            threadId: input.threadId,
            turnId,
            item: { type: "agentMessage", id: `item-${turnId}`, text: input.threadId }
          }
        });
        this.router.route({
          method: "turn/completed",
          params: {
            threadId: input.threadId,
            turn: { id: turnId, status: "completed" }
          }
        });
      }
      return { turn: { id: turnId, status: "inProgress" } } as TResult;
    }
    if (method === "turn/steer") {
      return { turnId: (params as { expectedTurnId: string }).expectedTurnId } as TResult;
    }
    if (method === "turn/interrupt") return {} as TResult;
    throw new Error(`Unexpected method ${method}`);
  }

  async notify(): Promise<void> {}
  async respond(): Promise<void> {}
  async respondError(_id: JsonRpcId, _error: JsonRpcErrorObject): Promise<void> {}
  async stop(): Promise<void> {}
}

test("uses native Thread and Turn methods while the router collects terminal output", async () => {
  const router = new CodexEventRouter();
  const runtime = new FakeRuntime(router);
  const coordinator = new TurnCoordinator({
    runtime,
    workspace: "/tmp/workspace",
    eventRouter: router
  });

  assert.deepEqual(await coordinator.runTurn("answer", undefined, { clientUserMessageId: "input-1" }), {
    threadId: "thread-1",
    turnId: "turn-for-thread-1",
    status: "completed",
    finalText: "thread-1",
    clientUserMessageId: "input-1"
  });
  assert.deepEqual(
    runtime.requests.map((request) => request.method),
    ["thread/start", "turn/start"]
  );
});

test("coordinates concurrent Turns on different Threads", async () => {
  const router = new CodexEventRouter();
  const runtime = new FakeRuntime(router);
  const coordinator = new TurnCoordinator({
    runtime,
    workspace: "/tmp/workspace",
    eventRouter: router
  });

  const [first, second] = await Promise.all([
    coordinator.runTurn("one", "thread-a"),
    coordinator.runTurn("two", "thread-b")
  ]);
  assert.equal(first.finalText, "thread-a");
  assert.equal(second.finalText, "thread-b");
  assert.deepEqual(
    runtime.requests.map((request) => request.method),
    ["thread/resume", "thread/resume", "turn/start", "turn/start"]
  );
});

test("timeout releases the Thread registration for later reconciliation or retry", async () => {
  const router = new CodexEventRouter();
  const runtime = new FakeRuntime(router);
  const coordinator = new TurnCoordinator({
    runtime,
    workspace: "/tmp/workspace",
    eventRouter: router,
    turnTimeoutMs: 10
  });

  runtime.completeTurns = false;
  await assert.rejects(coordinator.runTurn("hang", "thread-1"), /Timed out/);

  runtime.completeTurns = true;
  assert.equal((await coordinator.runTurn("retry", "thread-1")).status, "completed");
  assert.equal(
    runtime.requests.filter((request) => request.method === "thread/resume").length,
    1
  );
});

test("fails before turn/start when Codex resumes a different Thread", async () => {
  const router = new CodexEventRouter();
  const runtime = new FakeRuntime(router);
  const originalRequest = runtime.request.bind(runtime);
  runtime.request = async <TResult>(method: string, params?: unknown): Promise<TResult> => {
    if (method === "thread/resume") return { thread: { id: "wrong-thread" } } as TResult;
    return originalRequest<TResult>(method, params);
  };
  const coordinator = new TurnCoordinator({
    runtime,
    workspace: "/tmp/workspace",
    eventRouter: router
  });

  await assert.rejects(coordinator.runTurn("answer", "expected-thread"), /different Thread/);
  assert.equal(runtime.requests.some((request) => request.method === "turn/start"), false);
});

test("projects steer into native turn/steer with an exact active Turn target", async () => {
  const router = new CodexEventRouter();
  const runtime = new FakeRuntime(router);
  const coordinator = new TurnCoordinator({
    runtime,
    workspace: "/tmp/workspace",
    eventRouter: router
  });

  await coordinator.prepareThread("thread-1");
  await coordinator.steerTurn("change direction", {
    threadId: "thread-1",
    turnId: "turn-1"
  });
  assert.deepEqual(runtime.requests.at(-1), {
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "change direction" }],
      expectedTurnId: "turn-1"
    }
  });
});

test("rejects a steer response for a different Turn", async () => {
  const router = new CodexEventRouter();
  const runtime = new FakeRuntime(router);
  const originalRequest = runtime.request.bind(runtime);
  runtime.request = async <TResult>(method: string, params?: unknown): Promise<TResult> => {
    if (method === "turn/steer") return { turnId: "wrong-turn" } as TResult;
    return originalRequest<TResult>(method, params);
  };
  const coordinator = new TurnCoordinator({
    runtime,
    workspace: "/tmp/workspace",
    eventRouter: router
  });

  await coordinator.prepareThread("thread-1");
  await assert.rejects(
    coordinator.steerTurn("change direction", { threadId: "thread-1", turnId: "turn-1" }),
    /different Turn/
  );
});

test("projects interruption into native turn/interrupt with both identifiers", async () => {
  const router = new CodexEventRouter();
  const runtime = new FakeRuntime(router);
  const coordinator = new TurnCoordinator({
    runtime,
    workspace: "/tmp/workspace",
    eventRouter: router
  });

  await coordinator.prepareThread("thread-1");
  await coordinator.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });
  assert.deepEqual(runtime.requests.at(-1), {
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-1" }
  });
});
