import type { ProfileHealth } from "@codex-channel-bridge/core";
import type {
  WhatsAppChannelAccountAction,
  WhatsAppChannelAccountEvent,
  WhatsAppChannelAccountResult
} from "@codex-channel-bridge/whatsapp-adapter";

import type { ProfileWorkerConfig } from "./profile-worker.js";

export type SupervisorToWorkerMessage =
  | {
      readonly type: "start";
      readonly config: ProfileWorkerConfig;
    }
  | {
      readonly type: "stop";
    }
  | {
      readonly type: "whatsapp_action";
      readonly requestId: string;
      readonly channelAccountId: string;
      readonly action: WhatsAppChannelAccountAction;
    }
  | {
      readonly type: "codex_circuit_reset";
      readonly requestId: string;
    };

export type WorkerToSupervisorMessage =
  | {
      readonly type: "health";
      readonly health: ProfileHealth;
    }
  | {
      readonly type: "fatal";
      readonly reason: "worker_start_failed";
    }
  | {
      readonly type: "whatsapp_action_event";
      readonly requestId: string;
      readonly event: WhatsAppChannelAccountEvent;
    }
  | {
      readonly type: "whatsapp_action_result";
      readonly requestId: string;
      readonly result: WhatsAppChannelAccountResult;
    }
  | {
      readonly type: "whatsapp_action_error";
      readonly requestId: string;
      readonly error: {
        readonly code:
          | "profile_unavailable"
          | "channel_account_not_found"
          | "channel_account_busy"
          | "auth_revoke_uncertain"
          | "confirmation_mismatch"
          | "action_failed";
        readonly message: string;
      };
    }
  | {
      readonly type: "codex_circuit_reset_result";
      readonly requestId: string;
      readonly result: { readonly kind: "reset" };
    }
  | {
      readonly type: "codex_circuit_reset_error";
      readonly requestId: string;
      readonly error: {
        readonly code: "profile_unavailable" | "circuit_not_open" | "action_failed";
        readonly message: string;
      };
    };

export function isSupervisorToWorkerMessage(value: unknown): value is SupervisorToWorkerMessage {
  if (!isRecord(value)) return false;
  if (value.type === "stop") return true;
  if (value.type === "codex_circuit_reset") {
    return typeof value.requestId === "string" && value.requestId.length > 0;
  }
  if (value.type === "whatsapp_action") {
    return (
      typeof value.requestId === "string" &&
      value.requestId.length > 0 &&
      typeof value.channelAccountId === "string" &&
      value.channelAccountId.length > 0 &&
      isWhatsAppAction(value.action)
    );
  }
  if (value.type !== "start") return false;
  return isRecord(value.config) && typeof value.config.profileId === "string";
}

export function isWorkerToSupervisorMessage(value: unknown): value is WorkerToSupervisorMessage {
  if (!isRecord(value)) return false;
  if (value.type === "fatal") return value.reason === "worker_start_failed";
  if (value.type === "health") {
    return isRecord(value.health) &&
      typeof value.health.profileId === "string" &&
      typeof value.health.readiness === "string";
  }
  if (typeof value.requestId !== "string" || value.requestId.length === 0) return false;
  if (value.type === "codex_circuit_reset_result") {
    return isRecord(value.result) && value.result.kind === "reset";
  }
  if (value.type === "codex_circuit_reset_error") {
    return isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string";
  }
  if (value.type === "whatsapp_action_event") return isWhatsAppEvent(value.event);
  if (value.type === "whatsapp_action_result") return isWhatsAppResult(value.result);
  if (value.type === "whatsapp_action_error") {
    return isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string";
  }
  return false;
}

function isWhatsAppAction(value: unknown): value is WhatsAppChannelAccountAction {
  if (!isRecord(value)) return false;
  if (value.kind === "connect" || value.kind === "disconnect" || value.kind === "logout") {
    return true;
  }
  if (value.kind === "pair") {
    return value.timeoutMs === undefined || (
      Number.isInteger(value.timeoutMs) &&
      typeof value.timeoutMs === "number" &&
      value.timeoutMs >= 1_000 &&
      value.timeoutMs <= 300_000
    );
  }
  return value.kind === "forget_local" &&
    typeof value.confirmChannelAccountId === "string" &&
    value.confirmChannelAccountId.length > 0;
}

function isWhatsAppEvent(value: unknown): value is WhatsAppChannelAccountEvent {
  if (!isRecord(value) || value.kind !== "pairing_material" || !isRecord(value.material)) {
    return false;
  }
  return value.material.kind === "qr" &&
    typeof value.material.value === "string" &&
    value.material.value.length > 0 &&
    typeof value.material.expiresAtMs === "number";
}

function isWhatsAppResult(value: unknown): value is WhatsAppChannelAccountResult {
  if (!isRecord(value)) return false;
  if (
    value.kind === "connected" ||
    value.kind === "disconnected" ||
    value.kind === "logout_uncertain" ||
    value.kind === "local_auth_forgotten"
  ) return true;
  return value.kind === "paired" && typeof value.generationId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
