import type { NormalizedChannelMessage } from "./channel-event.js";

export type ChannelAttention = "direct" | "mention" | "passive";

export interface ChannelReplyTarget {
  readonly conversationKey: string;
  readonly conversationKind: NormalizedChannelMessage["conversationKind"];
  readonly providerConversationId: string;
  readonly providerReplyEventId?: string;
}

export interface InboundChannelEvent {
  readonly message: NormalizedChannelMessage;
  readonly attention: ChannelAttention;
  readonly replyTarget: ChannelReplyTarget;
}

export interface ChannelTextDelivery {
  readonly logicalResultId: string;
  readonly segmentIndex: number;
  readonly target: ChannelReplyTarget;
  readonly text: string;
}

export interface ChannelDeliveryReceipt {
  readonly logicalResultId: string;
  readonly segmentIndex: number;
  readonly outcome: "accepted";
  readonly providerMessageId: string;
  readonly acceptedAtMs: number;
}

export type ChannelDeliveryFailureOutcome = "rejected" | "ambiguous";

export class ChannelDeliveryError extends Error {
  public constructor(
    public readonly outcome: ChannelDeliveryFailureOutcome,
    message: string
  ) {
    super(message);
    this.name = "ChannelDeliveryError";
  }
}

export interface ChannelAdapter {
  start(onEvent: (event: InboundChannelEvent) => Promise<void>): Promise<void>;
  sendText(delivery: ChannelTextDelivery): Promise<ChannelDeliveryReceipt>;
  stop(): Promise<void>;
}
