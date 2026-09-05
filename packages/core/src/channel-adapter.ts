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
  /** Provider-stable sender used when a provider requires it for a quoted reply. */
  readonly providerReplyParticipantId?: string;
  /** Bounded original Channel text required to reconstruct provider quote context. */
  readonly providerReplyText?: string;
}

export interface ProviderReplyTarget {
  readonly conversationKind: ChannelConversationKind;
  readonly providerConversationId: string;
  readonly providerReplyEventId?: string;
}

export interface ProviderAttachmentContentSource {
  /** Open a single bounded provider byte stream. Callers must not invoke it twice. */
  openStream(): Promise<AsyncIterable<Uint8Array>>;
}

export interface ProviderInboundAttachment {
  /** Unique only within the provider event. */
  readonly providerAttachmentId: string;
  readonly contentType: string;
  readonly filename?: string;
  readonly sourceUrl?: string;
  readonly declaredSizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly transcript?: string;
  readonly contentSource?: ProviderAttachmentContentSource;
}

export type ArchiveAttachmentBytesState =
  | "metadata_only"
  | "pending"
  | "mirrored"
  | "unavailable";

export interface InboundChannelAttachment {
  readonly attachmentRecordId: string;
  readonly providerAttachmentId: string;
  readonly contentType: string;
  readonly filename?: string;
  readonly sourceUrl?: string;
  readonly declaredSizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly transcript?: string;
  readonly bytesState: ArchiveAttachmentBytesState;
  readonly contentSha256?: string;
  readonly mirroredSizeBytes?: number;
}

/** Provider-owned facts emitted by a Channel Adapter. */
export interface ProviderInboundEvent {
  readonly message: ProviderInboundMessage;
  readonly attention: ChannelAttention;
  readonly replyTarget: ProviderReplyTarget;
  readonly attachments?: readonly ProviderInboundAttachment[];
}

/** Trusted, archived Channel event emitted by the Inbound Pipeline. */
export interface InboundChannelEvent {
  readonly message: NormalizedChannelMessage;
  readonly attention: ChannelAttention;
  readonly replyTarget: ChannelReplyTarget;
  readonly attachments?: readonly InboundChannelAttachment[];
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

export interface ChannelFileDelivery extends Omit<ChannelTextDelivery, "text"> {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/** Native same-message update, not a new logical result or a typing indication. */
export interface ChannelAnswerFrame {
  readonly target: ChannelReplyTarget;
  readonly providerReplySequence: number;
  readonly providerMessageId?: string;
  readonly index: number;
  readonly text: string;
  readonly done: boolean;
}

export interface ChannelAnswerFrameReceipt {
  readonly providerMessageId: string;
  readonly acceptedAtMs: number;
  readonly remainingCharacters?: number;
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
  sendFile?(delivery: ChannelFileDelivery): Promise<ChannelDeliveryReceipt>;
  /** Optional provider-native answer stream. Unsupported targets must reject without sending. */
  sendAnswerFrame?(frame: ChannelAnswerFrame): Promise<ChannelAnswerFrameReceipt>;
  /** Best-effort native waiting indication. Returned cleanup is idempotent and non-blocking. */
  startTyping?(target: ChannelReplyTarget): (() => void) | undefined;
  stop(): Promise<void>;
  readiness(): ChannelAdapterReadiness;
  subscribeReadiness(
    listener: (readiness: ChannelAdapterReadiness) => void
  ): () => void;
}
