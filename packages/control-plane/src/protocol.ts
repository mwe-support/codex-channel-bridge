import type {
  ConfigurationApplyEntry,
  ConfigurationApplyResult,
  SupervisorStatus
} from "@codex-channel-bridge/supervisor";
import type { ProfileMigrationPlan, ProfileMigrationResult } from "@codex-channel-bridge/profile-store";

export const CONTROL_PROTOCOL_VERSION = 1 as const;

export type AdministrationMethod =
  | "status/get"
  | "config/plan"
  | "config/apply"
  | "migrate/plan"
  | "migrate/apply";

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

export type AdministrationResponse =
  | AdministrationSuccessResponse
  | AdministrationErrorResponse;

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

export interface AdministrationResults {
  readonly "status/get": SupervisorStatus;
  readonly "config/plan": ConfigurationPlanResult;
  readonly "config/apply": ConfigurationApplyResult;
  readonly "migrate/plan": MigrationPlanResult;
  readonly "migrate/apply": ProfileMigrationResult;
}

export function isAdministrationRequest(value: unknown): value is AdministrationRequest {
  if (!isRecord(value)) return false;
  return (
    value.version === CONTROL_PROTOCOL_VERSION &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.method === "status/get" ||
      value.method === "config/plan" ||
      value.method === "config/apply" ||
      value.method === "migrate/plan" ||
      value.method === "migrate/apply")
  );
}

export function isAdministrationResponse(value: unknown): value is AdministrationResponse {
  if (!isRecord(value)) return false;
  return (
    value.version === CONTROL_PROTOCOL_VERSION &&
    typeof value.id === "string" &&
    (("result" in value && !("error" in value)) ||
      ("error" in value &&
        isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string"))
  );
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
