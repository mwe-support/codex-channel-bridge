import assert from "node:assert/strict";
import test from "node:test";
import { parseConfiguration } from "@codex-channel-bridge/config";

import { AdmissionController } from "./admission-controller.js";

function request(workId: string, overrides: Record<string, unknown> = {}) {
  return {
    workId,
    channelAccountId: "qq-primary",
    threadKey: `thread-${workId}`,
    providerIdentity: "member-1",
    receivedAtMs: 1_000,
    ...overrides
  };
}

test("default admission lets independent conversations overlap while preserving exact Turn control", () => {
  const config = parseConfiguration(JSON.stringify({ schemaVersion: 1, profiles: { test: {
    workspace: "/tmp/test-workspace", codexHome: "/tmp/test-codex", stateDirectory: "/tmp/test-state"
  } } })).configuration.profiles.test!;
  const admission = new AdmissionController({ ...config.admission, accountRateLimit: 1000, ready: true });
  for (let i = 0; i < 70; i++) {
    assert.equal(admission.admit(request(`conversation-${i}`)).disposition.kind, "start");
    admission.markTurnStarted(`conversation-${i}`, { threadId: `native-${i}`, turnId: `turn-${i}` });
  }
  assert.deepEqual(admission.admit(request("follow-up", { threadKey: "thread-conversation-0" })).disposition,
    { kind: "steer", workId: "follow-up", target: { threadId: "native-0", turnId: "turn-0" } });
  assert.equal(admission.admit(request("other-participant", {
    threadKey: "thread-conversation-0", providerIdentity: "other"
  })).disposition.kind, "rejected");
  admission.release("conversation-0", 1001);
  assert.equal(admission.snapshot().active, 69);
  assert.deepEqual(admission.activeTurnFor("thread-conversation-1", "member-1"),
    { kind: "allowed", target: { threadId: "native-1", turnId: "turn-1" } });
});

test("steers the exact active Turn without consuming a new-Turn slot", () => {
  const admission = new AdmissionController({
    mode: "steer",
    maximumActiveTurns: 1,
    queueCapacity: 0,
    maximumQueueAgeMs: 1_000,
    accountRateLimit: 10,
    accountRateWindowMs: 1_000,
    ready: true
  });

  assert.equal(
    admission.admit(request("active", { threadKey: "shared-thread" })).disposition.kind,
    "start"
  );
  admission.markTurnStarted("active", {
    threadId: "thread-active",
    turnId: "turn-active"
  });
  assert.deepEqual(
    admission.admit(request("steer-1", { threadKey: "shared-thread" })).disposition,
    {
      kind: "steer",
      workId: "steer-1",
      target: { threadId: "thread-active", turnId: "turn-active" }
    }
  );
  assert.deepEqual(admission.snapshot(), { active: 1, queued: 0, ready: true });
  assert.deepEqual(
    admission.admit(
      request("other-member", {
        threadKey: "shared-thread",
        providerIdentity: "member-2"
      })
    ).disposition,
    { kind: "rejected", workId: "other-member", reason: "busy" }
  );
});

test("uses a bounded FIFO only in explicit queue mode", () => {
  const admission = new AdmissionController({
    mode: "queue",
    maximumActiveTurns: 1,
    queueCapacity: 2,
    maximumQueueAgeMs: 1_000,
    accountRateLimit: 10,
    accountRateWindowMs: 1_000,
    ready: true
  });

  assert.equal(admission.admit(request("one")).disposition.kind, "start");
  assert.deepEqual(admission.admit(request("two")).disposition, {
    kind: "queued",
    workId: "two",
    position: 1
  });
  assert.deepEqual(admission.admit(request("three")).disposition, {
    kind: "queued",
    workId: "three",
    position: 2
  });
  assert.deepEqual(admission.admit(request("four")).disposition, {
    kind: "rejected",
    workId: "four",
    reason: "busy"
  });
  assert.deepEqual(admission.release("one", 1_100).ready.map((entry) => entry.workId), ["two"]);
  assert.deepEqual(admission.release("two", 1_200).ready.map((entry) => entry.workId), ["three"]);
});

test("expires queued input and clears it when the Profile becomes unavailable", () => {
  const admission = new AdmissionController({
    mode: "queue",
    maximumActiveTurns: 1,
    queueCapacity: 3,
    maximumQueueAgeMs: 100,
    accountRateLimit: 10,
    accountRateWindowMs: 1_000,
    ready: true
  });
  admission.admit(request("active"));
  admission.admit(request("stale", { receivedAtMs: 1_001 }));
  const fresh = admission.admit(request("fresh", { receivedAtMs: 1_200 }));

  assert.deepEqual(fresh.expired, [{ workId: "stale", reason: "expired" }]);
  assert.deepEqual(admission.setReady(false, 1_200).expired, [
    { workId: "fresh", reason: "unavailable" }
  ]);
  assert.deepEqual(admission.admit(request("outage", { receivedAtMs: 1_201 })).disposition, {
    kind: "rejected",
    workId: "outage",
    reason: "unavailable"
  });
});

test("starts oldest eligible work while preserving order within a busy Thread", () => {
  const admission = new AdmissionController({ mode: "queue", maximumActiveTurns: 2,
    queueCapacity: 4, maximumQueueAgeMs: 1_000, accountRateLimit: 10,
    accountRateWindowMs: 1_000, ready: true });
  admission.admit(request("a"));
  admission.admit(request("b"));
  admission.admit(request("a2", { threadKey: "thread-a" }));
  admission.admit(request("a3", { threadKey: "thread-a" }));
  admission.admit(request("c"));
  assert.deepEqual(admission.release("b", 1_010).ready.map((entry) => entry.workId), ["c"]);
  assert.deepEqual(admission.snapshot(), { active: 2, queued: 2, ready: true });
  assert.deepEqual(admission.release("a", 1_020).ready.map((entry) => entry.workId), ["a2"]);
  assert.deepEqual(admission.release("a2", 1_030).ready.map((entry) => entry.workId), ["a3"]);
});

test("rate-limits each Channel Account independently", () => {
  const admission = new AdmissionController({
    mode: "steer",
    maximumActiveTurns: 3,
    queueCapacity: 0,
    maximumQueueAgeMs: 1_000,
    accountRateLimit: 1,
    accountRateWindowMs: 100,
    ready: true
  });
  assert.equal(admission.admit(request("one")).disposition.kind, "start");
  assert.deepEqual(admission.admit(request("two", { receivedAtMs: 1_001 })).disposition, {
    kind: "rejected",
    workId: "two",
    reason: "rate_limited"
  });
  assert.equal(
    admission.admit(
      request("other", { channelAccountId: "qq-secondary", receivedAtMs: 1_001 })
    ).disposition.kind,
    "start"
  );
  assert.equal(
    admission.admit(request("later", { receivedAtMs: 1_100 })).disposition.kind,
    "start"
  );
});
