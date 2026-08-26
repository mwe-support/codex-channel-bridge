import type { ProfileHealth } from "@codex-channel-bridge/core";

import type { ProfileWorkerConfig } from "./profile-worker.js";

export type SupervisorToWorkerMessage =
  | {
      readonly type: "start";
      readonly config: ProfileWorkerConfig;
    }
  | {
      readonly type: "stop";
    };

export type WorkerToSupervisorMessage =
  | {
      readonly type: "health";
      readonly health: ProfileHealth;
    }
  | {
      readonly type: "fatal";
      readonly reason: "worker_start_failed";
    };

export function isSupervisorToWorkerMessage(value: unknown): value is SupervisorToWorkerMessage {
  if (!isRecord(value) || (value.type !== "start" && value.type !== "stop")) return false;
  if (value.type === "stop") return true;
  return isRecord(value.config) && typeof value.config.profileId === "string";
}

export function isWorkerToSupervisorMessage(value: unknown): value is WorkerToSupervisorMessage {
  if (!isRecord(value)) return false;
  if (value.type === "fatal") return value.reason === "worker_start_failed";
  if (value.type !== "health" || !isRecord(value.health)) return false;
  return typeof value.health.profileId === "string" && typeof value.health.readiness === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
