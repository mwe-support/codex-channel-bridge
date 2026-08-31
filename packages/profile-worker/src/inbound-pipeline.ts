import type {
  ChannelReplyTarget,
  InboundChannelEvent,
  NormalizedChannelMessage,
  ProviderInboundEvent,
  TrustedChannelContext
} from "@codex-channel-bridge/core";

interface ArchiveCommitResult {
  readonly recordId: string;
  readonly inserted: boolean;
}

export interface InboundArchive {
  commitMessage(message: NormalizedChannelMessage): Promise<ArchiveCommitResult>;
}

export type InboundDisposition =
  | { readonly kind: "duplicate"; readonly archiveRecordId: string }
  | {
      readonly kind: "observed";
      readonly archiveRecordId: string;
      readonly event: InboundChannelEvent;
    };

export type InboundPipelineReason =
  | "invalid_trusted_channel_context"
  | "invalid_provider_event"
  | "provider_context_mismatch";

export class InboundPipelineError extends Error {
  public constructor(
    public readonly reason: InboundPipelineReason,
    message: string
  ) {
    super(message);
    this.name = "InboundPipelineError";
  }
}

/**
 * The single Profile-local entry for provider events. It injects Worker-owned
 * authority, derives Bridge routing identifiers, and commits observation before
 * exposing an event to later policy or Codex work.
 */
export class InboundPipeline {
  readonly #archive: InboundArchive;

  public constructor(archive: InboundArchive) {
    this.#archive = archive;
  }

  public async accept(
    context: TrustedChannelContext,
    providerEvent: ProviderInboundEvent
  ): Promise<InboundDisposition> {
    const event = normalizeInboundEvent(context, providerEvent);
    const commit = await this.#archive.commitMessage(event.message);
    if (!commit.inserted) {
      return { kind: "duplicate", archiveRecordId: commit.recordId };
    }
    return { kind: "observed", archiveRecordId: commit.recordId, event };
  }
}

function normalizeInboundEvent(
  context: TrustedChannelContext,
  providerEvent: ProviderInboundEvent
): InboundChannelEvent {
  validateContext(context);
  validateProviderEvent(providerEvent);
  if (providerEvent.message.provider !== context.provider) {
    throw new InboundPipelineError(
      "provider_context_mismatch",
      "Provider event does not match its trusted Channel context"
    );
  }

  const conversationKey = [
    context.provider,
    encodeURIComponent(context.channelAccountId),
    providerEvent.message.conversationKind,
    encodeURIComponent(providerEvent.message.providerConversationId)
  ].join(":");
  const replyTarget: ChannelReplyTarget = {
    conversationKey,
    conversationKind: providerEvent.replyTarget.conversationKind,
    providerConversationId: providerEvent.replyTarget.providerConversationId,
    ...(providerEvent.replyTarget.providerReplyEventId
      ? { providerReplyEventId: providerEvent.replyTarget.providerReplyEventId }
      : {}),
    ...(context.provider === "whatsapp" && providerEvent.replyTarget.providerReplyEventId
      ? {
          providerReplyParticipantId: providerEvent.message.providerIdentity,
          ...(providerEvent.message.text === null
            ? {}
            : { providerReplyText: providerEvent.message.text })
        }
      : {})
  };

  return {
    message: {
      profileId: context.profileId,
      provider: context.provider,
      channelAccountId: context.channelAccountId,
      channelAccountEpochId: context.channelAccountEpochId,
      providerEventId: providerEvent.message.providerEventId,
      conversationKey,
      conversationKind: providerEvent.message.conversationKind,
      providerConversationId: providerEvent.message.providerConversationId,
      providerIdentity: providerEvent.message.providerIdentity,
      observedAtMs: providerEvent.message.observedAtMs,
      text: providerEvent.message.text
    },
    attention: providerEvent.attention,
    replyTarget
  };
}

function validateContext(context: TrustedChannelContext): void {
  if (
    !context.profileId.trim() ||
    !context.channelAccountId.trim() ||
    !context.channelAccountEpochId.trim() ||
    (context.provider !== "qq" && context.provider !== "whatsapp")
  ) {
    throw new InboundPipelineError(
      "invalid_trusted_channel_context",
      "Trusted Channel context is invalid"
    );
  }
}

function validateProviderEvent(event: ProviderInboundEvent): void {
  const message = event.message;
  const replyTarget = event.replyTarget;
  if (
    (message.provider !== "qq" && message.provider !== "whatsapp") ||
    !message.providerEventId.trim() ||
    !message.providerConversationId.trim() ||
    !message.providerIdentity.trim() ||
    !Number.isSafeInteger(message.observedAtMs) ||
    message.observedAtMs < 0 ||
    (message.conversationKind !== "private" && message.conversationKind !== "group") ||
    (event.attention !== "direct" &&
      event.attention !== "mention" &&
      event.attention !== "passive") ||
    replyTarget.conversationKind !== message.conversationKind ||
    replyTarget.providerConversationId !== message.providerConversationId
  ) {
    throw new InboundPipelineError("invalid_provider_event", "Provider event is invalid");
  }
}
