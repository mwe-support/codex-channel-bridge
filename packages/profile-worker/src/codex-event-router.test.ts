import assert from "node:assert/strict";
import test from "node:test";

import type { JsonRpcNotification } from "@codex-channel-bridge/codex-app-server";
import { CodexEventRouter, CodexEventRouterError } from "./codex-event-router.js";

test("streams only the claimed Turn's final-answer item before completion", async () => {
  const router = new CodexEventRouter();
  const updates: string[] = [];
  const registration = router.beginTurn("thread-1", (text) => updates.push(text));
  for (const [itemId, phase] of [["comment", "commentary"], ["answer", "final_answer"]]) {
    router.route({ method: "item/started", params: {
      threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: itemId, phase, text: "" }
    } });
    router.route({ method: "item/agentMessage/delta", params: {
      threadId: "thread-1", turnId: "turn-1", itemId, delta: "hello"
    } });
  }
  assert.deepEqual(updates, []);
  registration.claim("turn-1");
  assert.deepEqual(updates, ["hello"]);
  router.route({ method: "item/agentMessage/delta", params: {
    threadId: "thread-1", turnId: "stale", itemId: "answer", delta: "wrong"
  } });
  router.route({ method: "item/agentMessage/delta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "answer", delta: " world"
  } });
  assert.deepEqual(updates, ["hello", "hello world"]);
  router.route(agentMessage("thread-1", "turn-1", "hello world"));
  router.route(completed("thread-1", "turn-1"));
  assert.deepEqual((await registration.completion).agentMessages, ["hello world"]);
});

test("claims only matching early notifications after turn/start returns", async () => {
  const router = new CodexEventRouter();
  const registration = router.beginTurn("thread-1");

  router.route(agentMessage("thread-1", "stale-turn", "stale"));
  router.route(completed("thread-1", "stale-turn"));
  router.route(agentMessage("thread-1", "turn-1", "first"));
  router.route(agentMessage("thread-1", "turn-1", "second"));
  router.route(completed("thread-1", "turn-1"));

  registration.claim("turn-1");
  assert.deepEqual(await registration.completion, {
    turnId: "turn-1",
    status: "completed",
    agentMessages: ["first", "second"]
  });
});

test("isolates concurrent Turns by Thread and Turn ID", async () => {
  const router = new CodexEventRouter();
  const first = router.beginTurn("thread-1");
  const second = router.beginTurn("thread-2");
  first.claim("turn-1");
  second.claim("turn-2");

  router.route(agentMessage("thread-2", "turn-2", "two"));
  router.route(agentMessage("thread-1", "turn-1", "one"));
  router.route(agentMessage("thread-1", "other-turn", "ignored"));
  router.route(completed("thread-2", "turn-2", "failed"));
  router.route(completed("thread-1", "turn-1"));

  assert.deepEqual(await Promise.all([first.completion, second.completion]), [
    { turnId: "turn-1", status: "completed", agentMessages: ["one"] },
    { turnId: "turn-2", status: "failed", agentMessages: ["two"] }
  ]);
});

test("keeps one unambiguous pending or active Turn per Thread", async () => {
  const router = new CodexEventRouter();
  const registration = router.beginTurn("thread-1");

  assert.throws(
    () => router.beginTurn("thread-1"),
    (error) =>
      error instanceof CodexEventRouterError && error.code === "thread_already_registered"
  );

  registration.cancel(new Error("cancelled"));
  await assert.rejects(registration.completion, /cancelled/);
  const replacement = router.beginTurn("thread-1");
  replacement.cancel(new Error("test complete"));
  await assert.rejects(replacement.completion, /test complete/);
});

test("fails a pending registration when its early-event buffer is full", async () => {
  const router = new CodexEventRouter({ maxBufferedSignals: 2 });
  const registration = router.beginTurn("thread-1");

  router.route(agentMessage("thread-1", "turn-1", "one"));
  router.route(agentMessage("thread-1", "turn-1", "two"));
  router.route(agentMessage("thread-1", "turn-1", "three"));

  await assert.rejects(
    registration.completion,
    (error) =>
      error instanceof CodexEventRouterError && error.code === "notification_buffer_overflow"
  );
});

test("close rejects all registrations and refuses new work", async () => {
  const router = new CodexEventRouter();
  const first = router.beginTurn("thread-1");
  const second = router.beginTurn("thread-2");
  second.claim("turn-2");

  router.close(new Error("runtime generation ended"));

  await assert.rejects(first.completion, /runtime generation ended/);
  await assert.rejects(second.completion, /runtime generation ended/);
  assert.throws(
    () => router.beginTurn("thread-3"),
    (error) => error instanceof CodexEventRouterError && error.code === "router_closed"
  );
});

function agentMessage(threadId: string, turnId: string, text: string): JsonRpcNotification {
  return {
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { type: "agentMessage", id: `item-${text}`, text }
    }
  };
}

function completed(
  threadId: string,
  turnId: string,
  status = "completed"
): JsonRpcNotification {
  return {
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status } }
  };
}
