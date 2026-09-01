import type { ProfileHealth } from "@codex-channel-bridge/core";

import { ProfileUnavailableError, ProfileWorker } from "./profile-worker.js";
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
  } else if (message.type === "stop") {
    void stopAndExit();
  } else if (message.type === "whatsapp_action") {
    void handleWhatsAppAction(message);
  } else {
    void handleCodexCircuitReset(message);
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

async function handleCodexCircuitReset(
  message: Extract<
    import("./worker-ipc.js").SupervisorToWorkerMessage,
    { readonly type: "codex_circuit_reset" }
  >
): Promise<void> {
  const active = worker;
  if (!active || stopping) {
    await send({
      type: "codex_circuit_reset_error",
      requestId: message.requestId,
      error: { code: "profile_unavailable", message: "Profile worker is unavailable" }
    }).catch(() => undefined);
    return;
  }
  try {
    const result = await active.resetCodexCircuit();
    await send({ type: "codex_circuit_reset_result", requestId: message.requestId, result });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "";
    await send({
      type: "codex_circuit_reset_error",
      requestId: message.requestId,
      error: messageText.includes("not open")
        ? { code: "circuit_not_open", message: "Codex circuit breaker is not open" }
        : { code: "action_failed", message: "Codex circuit reset failed" }
    }).catch(() => undefined);
  }
}

async function fatal(): Promise<void> {
  await send({ type: "fatal", reason: "worker_start_failed" }).catch(() => undefined);
  if (worker) await worker.stop().catch(() => undefined);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}

async function handleWhatsAppAction(
  message: Extract<
    import("./worker-ipc.js").SupervisorToWorkerMessage,
    { readonly type: "whatsapp_action" }
  >
): Promise<void> {
  const active = worker;
  if (!active || stopping) {
    await send({
      type: "whatsapp_action_error",
      requestId: message.requestId,
      error: { code: "profile_unavailable", message: "Profile worker is unavailable" }
    }).catch(() => undefined);
    return;
  }
  try {
    const result = await active.executeWhatsAppAccountAction(
      message.channelAccountId,
      message.action,
      async (event) => send({
        type: "whatsapp_action_event",
        requestId: message.requestId,
        event
      })
    );
    await send({ type: "whatsapp_action_result", requestId: message.requestId, result });
  } catch (error) {
    await send({
      type: "whatsapp_action_error",
      requestId: message.requestId,
      error: classifyWhatsAppActionError(error)
    }).catch(() => undefined);
  }
}

function classifyWhatsAppActionError(error: unknown): Extract<
  WorkerToSupervisorMessage,
  { readonly type: "whatsapp_action_error" }
>["error"] {
  if (error instanceof ProfileUnavailableError) {
    return { code: "profile_unavailable", message: "Profile worker is unavailable" };
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("not configured")) {
    return { code: "channel_account_not_found", message: "WhatsApp Channel Account is not configured" };
  }
  if (message.includes("live work")) {
    return { code: "channel_account_busy", message: "WhatsApp Channel Account has live work" };
  }
  if (message.includes("revocation is uncertain")) {
    return { code: "auth_revoke_uncertain", message: "WhatsApp authentication revocation is uncertain" };
  }
  if (message.includes("confirmation did not match")) {
    return { code: "confirmation_mismatch", message: "Complete Channel Account ID confirmation did not match" };
  }
  return { code: "action_failed", message: "WhatsApp Channel Account action failed" };
}

async function send(message: WorkerToSupervisorMessage): Promise<void> {
  if (!process.connected || !process.send) return;
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()));
  });
}
