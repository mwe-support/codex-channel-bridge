import type { ChannelReplyTarget } from "./channel-adapter.js";
import type { ChannelProvider } from "./channel-event.js";

export interface LogicalResultSegmentInput {
  readonly text: string;
  readonly file?: OutputFile;
}

/** Immutable Profile-owned snapshot; never an original host path or provider URL. */
export interface OutputFile {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly filename: string;
}

export function validOutputFile(file: OutputFile): boolean {
  return !!file && /^[a-f0-9]{64}$/.test(file.sha256) &&
    Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0 && file.sizeBytes <= 64 * 1024 * 1024 &&
    typeof file.filename === "string" && file.filename.length <= 200 &&
    !/[/\\\x00-\x1f\x7f]/.test(file.filename) && !file.filename.startsWith(".") && file.filename.length > 0;
}

/**
 * Bridge-owned terminal delivery input for one Codex Turn. The Profile Store
 * assigns the Logical Result and Outbox identities atomically.
 */
export interface LogicalResultInput {
  readonly profileId: string;
  readonly codexThreadId: string;
  readonly codexTurnId: string;
  readonly provider: ChannelProvider;
  readonly channelAccountId: string;
  readonly channelAccountEpochId: string;
  readonly target: ChannelReplyTarget;
  readonly completedAtMs: number;
  readonly segments: readonly LogicalResultSegmentInput[];
}
