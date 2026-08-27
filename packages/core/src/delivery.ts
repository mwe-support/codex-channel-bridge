import type { ChannelReplyTarget } from "./channel-adapter.js";
import type { ChannelProvider } from "./channel-event.js";

export interface LogicalResultSegmentInput {
  readonly text: string;
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
