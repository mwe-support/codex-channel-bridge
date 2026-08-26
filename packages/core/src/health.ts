export type ProfileReadiness =
  | "starting"
  | "ready"
  | "degraded"
  | "unavailable"
  | "draining"
  | "stopped";

export type ProfileReasonCode =
  | "codex_not_found"
  | "codex_start_failed"
  | "incompatible_codex_protocol"
  | "unsupported_codex_version"
  | "invalid_profile_configuration"
  | "protocol_fault"
  | "profile_store_unavailable"
  | "worker_process_exit"
  | "worker_restart_exhausted"
  | "worker_start_failed"
  | "worker_stop_timeout"
  | null;

export type CodexVerification = "tested" | "unverified";

export interface ProfileHealth {
  readonly profileId: string;
  readonly readiness: ProfileReadiness;
  readonly reason: ProfileReasonCode;
  readonly codexVersion?: string;
  readonly codexVerification?: CodexVerification;
}
