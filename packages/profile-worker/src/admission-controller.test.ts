import assert from "node:assert/strict";
import test from "node:test";

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
