export type ChannelProvider = "qq" | "whatsapp";

export type ChannelConversationKind = "private" | "group";

/**
 * Channel-neutral message data produced by a provider Adapter before Bridge
 * access, routing, archival, or Codex work begins.
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
