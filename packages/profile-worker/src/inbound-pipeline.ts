import type {
  ChannelReplyTarget,
  InboundChannelEvent,
  InboundChannelAttachment,
  ProviderInboundEvent,
  TrustedChannelContext
} from "@codex-channel-bridge/core";
import type {
  ArchiveAttachmentRecord,
  ArchiveObservationCommitResult,
  CommitArchiveObservationInput
} from "@codex-channel-bridge/profile-store";

import { type MediaArchive, toInboundAttachment } from "./media-archive.js";

export interface InboundArchive {
  commitObservation(input: CommitArchiveObservationInput): Promise<ArchiveObservationCommitResult>;
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
  readonly #media?: MediaArchive;

  public constructor(archive: InboundArchive, media?: MediaArchive) {
    this.#archive = archive;
    this.#media = media;
  }

  public async accept(
    context: TrustedChannelContext,
    providerEvent: ProviderInboundEvent
  ): Promise<InboundDisposition> {
    const event = normalizeInboundEvent(context, providerEvent);
    const observation = {
      message: event.message,
      attachments: (providerEvent.attachments ?? []).map((attachment) => ({
        providerAttachmentId: attachment.providerAttachmentId,
        contentType: attachment.contentType,
        ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
        ...(attachment.sourceUrl === undefined ? {} : { sourceUrl: attachment.sourceUrl }),
        ...(attachment.declaredSizeBytes === undefined
          ? {}
          : { declaredSizeBytes: attachment.declaredSizeBytes }),
        ...(attachment.width === undefined ? {} : { width: attachment.width }),
        ...(attachment.height === undefined ? {} : { height: attachment.height }),
        ...(attachment.transcript === undefined ? {} : { transcript: attachment.transcript }),
        bytesState: attachment.contentSource === undefined ? "metadata_only" : "pending"
      }))
    } satisfies CommitArchiveObservationInput;
    const commit = await this.#archive.commitObservation(observation);
    const attachments = await this.#mirrorAttachments(commit.attachments, providerEvent);
    if (!commit.inserted) {
      return { kind: "duplicate", archiveRecordId: commit.recordId };
    }
    return {
      kind: "observed",
      archiveRecordId: commit.recordId,
      event: { ...event, ...(attachments.length === 0 ? {} : { attachments }) }
    };
  }

  async #mirrorAttachments(
    records: readonly ArchiveAttachmentRecord[],
    providerEvent: ProviderInboundEvent
  ): Promise<readonly InboundChannelAttachment[]> {
    const sources = new Map(
      (providerEvent.attachments ?? [])
        .filter((attachment) => attachment.contentSource !== undefined)
        .map((attachment) => [attachment.providerAttachmentId, attachment.contentSource!])
    );
    const result: InboundChannelAttachment[] = [];
    for (const record of records) {
      const source = sources.get(record.providerAttachmentId);
      result.push(
        this.#media && source && record.bytesState === "pending"
          ? await this.#media.mirror(record, source)
          : toInboundAttachment(record)
      );
    }
    return result;
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
    replyTarget.providerConversationId !== message.providerConversationId ||
    !validProviderAttachments(event)
  ) {
    throw new InboundPipelineError("invalid_provider_event", "Provider event is invalid");
  }
}

function validProviderAttachments(event: ProviderInboundEvent): boolean {
  const ids = new Set<string>();
  for (const attachment of event.attachments ?? []) {
    if (
      !attachment.providerAttachmentId.trim() ||
      ids.has(attachment.providerAttachmentId) ||
      !attachment.contentType.trim() ||
      (attachment.declaredSizeBytes !== undefined &&
        (!Number.isSafeInteger(attachment.declaredSizeBytes) || attachment.declaredSizeBytes < 0))
    ) return false;
    ids.add(attachment.providerAttachmentId);
  }
  return true;
}
