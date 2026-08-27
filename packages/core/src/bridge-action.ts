export type BridgeAction =
  | { readonly kind: "turn.start"; readonly archiveRecordId: string }
  | {
      readonly kind: "turn.steer";
      readonly archiveRecordId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
    }
  | {
      readonly kind: "turn.interrupt";
      readonly threadId: string;
      readonly turnId: string;
    }
  | {
      readonly kind: "approval.respond";
      readonly requestId: string | number;
      readonly decision: string;
    }
  | {
      readonly kind: "user_input.respond";
      readonly requestId: string | number;
      readonly answers: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly kind: "model.select"; readonly modelId: string }
  | { readonly kind: "reasoning.select"; readonly effort: string }
  | { readonly kind: "status.read" }
  | { readonly kind: "help.read" };

/**
 * Authority is supplied separately by the trusted Profile pipeline. Actions
 * intentionally cannot claim a Profile, Channel Account, or Participant.
 */
export interface AuthorizedParticipantContext {
  readonly profileId: string;
  readonly channelAccountId: string;
  readonly channelAccountEpochId: string;
  readonly conversationKey: string;
  readonly providerIdentity: string;
}
