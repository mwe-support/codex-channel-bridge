import type {
  ChannelConversationKind,
  NormalizedChannelMessage,
  ProviderInboundMessage
} from "./channel-event.js";

export type ChannelAttention = "direct" | "mention" | "passive";

export interface ChannelReplyTarget {
  readonly conversationKey: string;
  readonly conversationKind: NormalizedChannelMessage["conversationKind"];
  readonly providerConversationId: string;
  readonly providerReplyEventId?: string;
}

export interface ProviderReplyTarget {
  readonly conversationKind: ChannelConversationKind;
  readonly providerConversationId: string;
  readonly providerReplyEventId?: string;
}

/** Provider-owned facts emitted by a Channel Adapter. */
export interface ProviderInboundEvent {
  readonly message: ProviderInboundMessage;
  readonly attention: ChannelAttention;
  readonly replyTarget: ProviderReplyTarget;
}

/** Trusted, archived Channel event emitted by the Inbound Pipeline. */
export interface InboundChannelEvent {
  readonly message: NormalizedChannelMessage;
  readonly attention: ChannelAttention;
  readonly replyTarget: ChannelReplyTarget;
}

export interface ChannelTextDelivery {
  readonly logicalResultId: string;
  readonly segmentIndex: number;
  readonly target: ChannelReplyTarget;
  /** Stable provider reply sequence allocated before the first passive send. */
  readonly providerReplySequence?: number;
  readonly text: string;
}

export interface ChannelDeliveryReceipt {
  readonly logicalResultId: string;
  readonly segmentIndex: number;
  readonly outcome: "accepted";
  readonly providerMessageId: string;
  readonly acceptedAtMs: number;
}

export type ChannelDeliveryFailureOutcome = "rejected" | "ambiguous" | "deferred";

export class ChannelDeliveryError extends Error {
  public constructor(
    public readonly outcome: ChannelDeliveryFailureOutcome,
    message: string,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ChannelDeliveryError";
  }
}

export type ChannelAdapterReadiness = "stopped" | "starting" | "ready" | "degraded";

export interface ChannelAdapter {
  start(onEvent: (event: ProviderInboundEvent) => Promise<void>): Promise<void>;
  sendText(delivery: ChannelTextDelivery): Promise<ChannelDeliveryReceipt>;
  stop(): Promise<void>;
  /** In-tree adapters expose lifecycle changes through this channel-neutral edge. */
  readiness?(): ChannelAdapterReadiness;
  subscribeReadiness?(
    listener: (readiness: ChannelAdapterReadiness) => void
  ): () => void;
}
