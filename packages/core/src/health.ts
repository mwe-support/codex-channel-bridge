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
  | "codex_restart_exhausted"
  | "profile_store_unavailable"
  | "migration_required"
  | "channel_adapter_unavailable"
  | "worker_process_exit"
  | "worker_restart_exhausted"
  | "worker_start_failed"
  | "worker_stop_timeout"
  | "maintenance_hold"
  | "storage_pressure"
  | null;

export type CodexVerification = "tested" | "unverified";

export interface ChannelAccountHealth {
  readonly channelAccountId: string;
  readonly provider: "qq" | "whatsapp";
  readonly readiness: "stopped" | "starting" | "ready" | "degraded";
}

export interface ProfileHealth {
  readonly profileId: string;
  readonly readiness: ProfileReadiness;
  readonly reason: ProfileReasonCode;
  readonly codexVersion?: string;
  readonly codexVerification?: CodexVerification;
  readonly channelAccounts?: readonly ChannelAccountHealth[];
}
