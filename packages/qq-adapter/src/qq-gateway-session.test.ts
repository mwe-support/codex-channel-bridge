import assert from "node:assert/strict";
import test from "node:test";

import type { PersistedSession } from "@tencent-connect/qqbot-nodejs/protocol";

import {
  QQGatewaySessionCoordinator,
  type QQGatewaySessionRepository
} from "./qq-gateway-session.js";

class MemoryRepository implements QQGatewaySessionRepository {
  current: PersistedSession | null;
  readonly saved: PersistedSession[] = [];

  constructor(initial: PersistedSession | null = null) {
    this.current = initial;
  }

  async load(): Promise<PersistedSession | null> {
    return this.current;
  }

  async save(session: PersistedSession): Promise<void> {
    this.current = { ...session };
    this.saved.push({ ...session });
  }

  async clear(): Promise<void> {
    this.current = null;
  }
}

test("restores only the durable sequence into the pinned QQ SDK", async () => {
  const repository = new MemoryRepository({ sessionId: "session-a", lastSeq: 41 });
  const coordinator = new QQGatewaySessionCoordinator(repository);
  await coordinator.restore();
  assert.deepEqual(coordinator.sdkPort.load(), { sessionId: "session-a", lastSeq: 41 });
});

test("does not persist a later QQ sequence past an earlier uncommitted message", async () => {
  const repository = new MemoryRepository();
  const coordinator = new QQGatewaySessionCoordinator(repository);
  await coordinator.restore();

  coordinator.sdkPort.save({ sessionId: "session-a", lastSeq: 10 });
  const first = coordinator.claimMessage();
  coordinator.sdkPort.save({ sessionId: "session-a", lastSeq: 11 });
  const second = coordinator.claimMessage();

  await coordinator.commitMessage(second);
  assert.deepEqual(repository.saved, []);
  await coordinator.commitMessage(first);
  assert.deepEqual(repository.saved, [{ sessionId: "session-a", lastSeq: 11 }]);
});

test("leaves an unarchived sequence replayable after a commit failure", async () => {
  const repository = new MemoryRepository({ sessionId: "session-a", lastSeq: 5 });
  const coordinator = new QQGatewaySessionCoordinator(repository);
  await coordinator.restore();
  coordinator.sdkPort.save({ sessionId: "session-a", lastSeq: 6 });
  assert.ok(coordinator.claimMessage());
  await coordinator.settled();
  assert.deepEqual(repository.current, { sessionId: "session-a", lastSeq: 5 });
});

test("clears an invalidated QQ session durably", async () => {
  const repository = new MemoryRepository({ sessionId: "session-a", lastSeq: 5 });
  const coordinator = new QQGatewaySessionCoordinator(repository);
  await coordinator.restore();
  coordinator.sdkPort.clear();
  await coordinator.settled();
  assert.equal(repository.current, null);
  assert.equal(coordinator.sdkPort.load(), null);
});
