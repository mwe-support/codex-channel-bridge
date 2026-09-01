import type {
  ConfigurationApplyEntry,
  ConfigurationApplyResult,
  SupervisorStatus,
  WhatsAppChannelAccountEvent,
  WhatsAppChannelAccountResult
} from "@codex-channel-bridge/supervisor";
import type {
  ArchivePurgePreview,
  ArchivePurgeResult,
  ProfileMigrationPlan,
  ProfileMigrationResult
} from "@codex-channel-bridge/profile-store";
import type { ProfilePurgePreview, ProfilePurgeResult } from "./profile-purge.js";
import type { OperationsInspection } from "./operations-inspector.js";
import type {
  BackupPrepareResult,
  RestoreValidationResult
} from "./backup-coordinator.js";
import type {
  AuditRetentionPlan,
  ProfileAuditRecord
} from "./audit-manager.js";
import type { SupportBundlePlan } from "./support-bundle.js";

export const CONTROL_PROTOCOL_VERSION = 1 as const;

export type AdministrationMethod =
  | "status/get"
  | "doctor/run"
  | "backup/prepare"
  | "backup/finish"
  | "restore/validate"
  | "audit/query"
  | "audit/export"
  | "audit/retention-plan"
  | "audit/retention-apply"
  | "support/plan"
  | "support/apply"
  | "circuit/reset"
  | "config/plan"
  | "config/apply"
  | "migrate/plan"
  | "migrate/apply"
  | "archive/purge-plan"
  | "archive/purge-apply"
  | "profile/purge-plan"
  | "profile/purge-apply"
  | "channel/connect"
  | "channel/disconnect"
  | "whatsapp/pair"
  | "whatsapp/logout"
  | "whatsapp/forget-local";

export interface AdministrationRequest {
  readonly version: typeof CONTROL_PROTOCOL_VERSION;
  readonly id: string;
  readonly method: AdministrationMethod;
  readonly params?: unknown;
}

export interface AdministrationSuccessResponse {
  readonly version: typeof CONTROL_PROTOCOL_VERSION;
  readonly id: string;
  readonly result: unknown;
}

export interface AdministrationErrorResponse {
  readonly version: typeof CONTROL_PROTOCOL_VERSION;
  readonly id: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface AdministrationEventResponse {
  readonly version: typeof CONTROL_PROTOCOL_VERSION;
  readonly id: string;
  readonly event: WhatsAppChannelAccountEvent;
}

export type AdministrationResponse =
  | AdministrationSuccessResponse
  | AdministrationErrorResponse
  | AdministrationEventResponse;

export interface ConfigurationPlanResult {
  readonly planToken: string;
  readonly previousRevision: string | null;
  readonly candidateRevision: string;
  readonly entries: readonly ConfigurationApplyEntry[];
  readonly expiresAt: number;
}

export interface MigrationPlanResult extends ProfileMigrationPlan {
  readonly planToken: string;
  readonly configurationRevision: string;
  readonly expiresAt: number;
  readonly requiredBackupManifest: {
    readonly schemaVersion: 1;
    readonly kind: "codex-channel-bridge-profile-snapshot";
    readonly profileId: string;
    readonly sourceDigest: string;
    readonly completedAtMs: "POSITIVE_INTEGER";
  };
}

export interface ArchivePurgePlanResult extends ArchivePurgePreview {
  readonly planToken: string;
  readonly configurationRevision: string;
  readonly expiresAt: number;
}

export interface ArchivePurgeApplyResult extends ArchivePurgeResult {
  readonly mediaCleanupFailures: number;
}

export interface ProfilePurgePlanResult extends ProfilePurgePreview {
  readonly planToken: string;
  readonly configurationRevision: string;
  readonly expiresAt: number;
}

export interface AdministrationResults {
  readonly "status/get": SupervisorStatus;
  readonly "doctor/run": OperationsInspection;
  readonly "backup/prepare": BackupPrepareResult;
  readonly "backup/finish": { readonly profileId: string; readonly resumed: boolean };
  readonly "restore/validate": RestoreValidationResult;
  readonly "audit/query": readonly ProfileAuditRecord[];
  readonly "audit/export": { readonly recordCount: number; readonly destination: string };
  readonly "audit/retention-plan": AuditRetentionPlan;
  readonly "audit/retention-apply": import("@codex-channel-bridge/profile-store").AuditRetentionResult;
  readonly "support/plan": SupportBundlePlan;
  readonly "support/apply": {
    readonly outputPath: string;
    readonly profileIds: readonly string[];
    readonly fileCount: number;
    readonly manifestDigest: string;
  };
  readonly "circuit/reset": import("@codex-channel-bridge/supervisor").CodexCircuitResetResult;
  readonly "config/plan": ConfigurationPlanResult;
  readonly "config/apply": ConfigurationApplyResult;
  readonly "migrate/plan": MigrationPlanResult;
  readonly "migrate/apply": ProfileMigrationResult;
  readonly "archive/purge-plan": ArchivePurgePlanResult;
  readonly "archive/purge-apply": ArchivePurgeApplyResult;
  readonly "profile/purge-plan": ProfilePurgePlanResult;
  readonly "profile/purge-apply": ProfilePurgeResult;
  readonly "channel/connect": WhatsAppChannelAccountResult;
  readonly "channel/disconnect": WhatsAppChannelAccountResult;
  readonly "whatsapp/pair": WhatsAppChannelAccountResult;
  readonly "whatsapp/logout": WhatsAppChannelAccountResult;
  readonly "whatsapp/forget-local": WhatsAppChannelAccountResult;
}

export function isAdministrationRequest(value: unknown): value is AdministrationRequest {
  if (!isRecord(value)) return false;
  return (
    value.version === CONTROL_PROTOCOL_VERSION &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.method === "status/get" ||
      value.method === "doctor/run" ||
      value.method === "backup/prepare" ||
      value.method === "backup/finish" ||
      value.method === "restore/validate" ||
      value.method === "audit/query" ||
      value.method === "audit/export" ||
      value.method === "audit/retention-plan" ||
      value.method === "audit/retention-apply" ||
      value.method === "support/plan" ||
      value.method === "support/apply" ||
      value.method === "circuit/reset" ||
      value.method === "config/plan" ||
      value.method === "config/apply" ||
      value.method === "migrate/plan" ||
      value.method === "migrate/apply" ||
      value.method === "archive/purge-plan" ||
      value.method === "archive/purge-apply" ||
      value.method === "profile/purge-plan" ||
      value.method === "profile/purge-apply" ||
      value.method === "channel/connect" ||
      value.method === "channel/disconnect" ||
      value.method === "whatsapp/pair" ||
      value.method === "whatsapp/logout" ||
      value.method === "whatsapp/forget-local")
  );
}

export function isAdministrationResponse(value: unknown): value is AdministrationResponse {
  if (!isRecord(value)) return false;
  return (
    value.version === CONTROL_PROTOCOL_VERSION &&
    typeof value.id === "string" &&
    (("result" in value && !("error" in value) && !("event" in value)) ||
      ("event" in value && !("result" in value) && !("error" in value) && isWhatsAppEvent(value.event)) ||
      ("error" in value &&
        !("event" in value) &&
        isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string"))
  );
}

function isWhatsAppEvent(value: unknown): value is WhatsAppChannelAccountEvent {
  if (!isRecord(value) || value.kind !== "pairing_material" || !isRecord(value.material)) {
    return false;
  }
  return value.material.kind === "qr" &&
    typeof value.material.value === "string" &&
    typeof value.material.expiresAtMs === "number";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
