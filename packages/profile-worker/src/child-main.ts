import type { ProfileHealth } from "@codex-channel-bridge/core";

import { ProfileWorker } from "./profile-worker.js";
import {
  isSupervisorToWorkerMessage,
  type WorkerToSupervisorMessage
} from "./worker-ipc.js";

let worker: ProfileWorker | undefined;
let stopping = false;

process.on("message", (message: unknown) => {
  if (!isSupervisorToWorkerMessage(message)) return;
  if (message.type === "start") {
    if (worker || stopping) return;
    worker = new ProfileWorker(message.config);
    worker.on("health", (health: ProfileHealth) => void send({ type: "health", health }));
    void worker.start().catch(() => fatal());
  } else {
    void stopAndExit();
  }
});

process.once("disconnect", () => void stopAndExit());
process.once("SIGTERM", () => void stopAndExit());
process.once("SIGINT", () => void stopAndExit());
process.once("uncaughtException", () => void fatal());
process.once("unhandledRejection", () => void fatal());

async function stopAndExit(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (worker) await worker.stop().catch(() => undefined);
  if (process.connected) process.disconnect();
  process.exitCode = 0;
}

async function fatal(): Promise<void> {
  await send({ type: "fatal", reason: "worker_start_failed" }).catch(() => undefined);
  if (worker) await worker.stop().catch(() => undefined);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}

async function send(message: WorkerToSupervisorMessage): Promise<void> {
  if (!process.connected || !process.send) return;
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()));
  });
}
