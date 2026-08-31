import assert from "node:assert/strict";
import test from "node:test";

import { CodexRestartController } from "./codex-restart-controller.js";

test("coalesces callers and recovers within one bounded restart budget", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const controller = new CodexRestartController({
    delaysMs: [10, 20],
    cooldownMs: 100,
    random: () => 0.5,
    sleep: async (delayMs) => void sleeps.push(delayMs)
  });
  const attempt = async () => {
    attempts += 1;
    return attempts === 2;
  };
  const first = controller.recover(attempt, () => assert.fail("circuit should stay closed"));
  const second = controller.recover(attempt, () => assert.fail("circuit should stay closed"));
  assert.equal(first, second);
  assert.equal(await first, true);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [10, 20]);
});

test("opens the circuit after exhaustion and retries only after cooldown", async () => {
  const gates: Array<() => void> = [];
  const sleeps: number[] = [];
  let attempts = 0;
  let opened = 0;
  const controller = new CodexRestartController({
    delaysMs: [0, 0],
    cooldownMs: 50,
    random: () => 0.5,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      if (delayMs === 50) await new Promise<void>((resolve) => gates.push(resolve));
    }
  });
  const recovered = controller.recover(async () => {
    attempts += 1;
    return attempts === 3;
  }, () => {
    opened += 1;
  });
  await eventually(() => gates.length === 1);
  assert.equal(opened, 1);
  assert.equal(attempts, 2);
  gates.shift()!();
  assert.equal(await recovered, true);
  assert.deepEqual(sleeps, [0, 0, 50, 0]);
});

test("cancels a pending recovery before another generation starts", async () => {
  let release!: () => void;
  let attempts = 0;
  const controller = new CodexRestartController({
    delaysMs: [1],
    cooldownMs: 10,
    sleep: async () => new Promise<void>((resolve) => {
      release = resolve;
    })
  });
  const recovery = controller.recover(async () => {
    attempts += 1;
    return true;
  }, () => undefined);
  await eventually(() => release !== undefined);
  controller.stop();
  release();
  assert.equal(await recovery, false);
  assert.equal(attempts, 0);
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}
