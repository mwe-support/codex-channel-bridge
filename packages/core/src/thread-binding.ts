export type ThreadBindingScope = "conversation" | "participant";

export interface ThreadBindingKey {
  readonly conversationKey: string;
  readonly scope: ThreadBindingScope;
  /** Required only when scope is participant. */
  readonly providerIdentity?: string;
}

export interface ThreadBinding extends ThreadBindingKey {
  readonly bindingId: string;
  readonly profileId: string;
  readonly codexThreadId: string;
  readonly boundAtMs: number;
}

export interface CodexInputAcceptance {
  readonly profileId: string;
  readonly archiveRecordId: string;
  readonly bindingId: string;
  readonly codexThreadId: string;
  readonly clientUserMessageId: string;
  readonly acceptedAtMs: number;
}

export type CodexInputState = "accepted" | "started" | "terminal" | "uncertain";

export interface CodexInputCorrelation extends CodexInputAcceptance {
  readonly correlationId: string;
  readonly state: CodexInputState;
  readonly codexTurnId?: string;
  readonly terminalStatus?: string;
  readonly reasonCode?: string;
  readonly updatedAtMs: number;
}
