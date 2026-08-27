export type ChannelProvider = "qq" | "whatsapp";

export type ChannelConversationKind = "private" | "group";

/**
 * Bridge-authoritative context injected by the Profile worker that owns the
 * Adapter instance. Provider events must never supply these values.
 */
export interface TrustedChannelContext {
  readonly profileId: string;
  readonly provider: ChannelProvider;
  readonly channelAccountId: string;
  readonly channelAccountEpochId: string;
}

/** Provider facts produced by an Adapter before Bridge-owned processing. */
export interface ProviderInboundMessage {
  readonly provider: ChannelProvider;
  readonly providerEventId: string;
  readonly conversationKind: ChannelConversationKind;
  readonly providerConversationId: string;
  readonly providerIdentity: string;
  readonly observedAtMs: number;
  readonly text: string | null;
}

/**
 * Message Archive input after the Profile worker has injected trusted routing
 * context and the Inbound Pipeline has derived the Conversation Key.
 */
export interface NormalizedChannelMessage {
  readonly profileId: string;
  readonly provider: ChannelProvider;
  readonly channelAccountId: string;
  readonly channelAccountEpochId: string;
  readonly providerEventId: string;
  readonly conversationKey: string;
  readonly conversationKind: ChannelConversationKind;
  readonly providerIdentity: string;
  readonly observedAtMs: number;
  readonly text: string | null;
}
