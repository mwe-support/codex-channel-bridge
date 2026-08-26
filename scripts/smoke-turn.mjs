import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ProfileWorker } from "../packages/profile-worker/dist/index.js";

const marker = "CODEX_CHANNEL_BRIDGE_SMOKE_OK";
const stateDirectory = await mkdtemp(join(tmpdir(), "bridge-smoke-state-"));
const worker = new ProfileWorker({
  profileId: "local-smoke",
  workspace: resolve(process.env.BRIDGE_SMOKE_WORKSPACE ?? process.cwd()),
  codexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")),
  stateDirectory,
  codexExecutable: process.env.CODEX_EXECUTABLE
});

try {
  const health = await worker.start();
  assert.equal(health.readiness, "ready", `Profile did not become ready: ${health.reason}`);
  const result = await worker.runTurn(`Reply with exactly: ${marker}`);
  assert.equal(result.status, "completed");
  assert.equal(result.finalText.trim(), marker);
  process.stdout.write(
    `${JSON.stringify({ ok: true, threadId: result.threadId, turnId: result.turnId })}\n`
  );
} finally {
  await worker.stop();
  await rm(stateDirectory, { force: true, recursive: true });
}
