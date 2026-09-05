import { randomUUID } from "node:crypto";

import type {
  CodexInputAcceptance,
  CodexInputCorrelation,
  InboundChannelEvent,
  LogicalResultSegmentInput,
  ThreadBinding,
  ThreadBindingKey,
  ThreadBindingScope
} from "@codex-channel-bridge/core";
import type {
  CodexInputCommitResult,
  CodexInputUncertaintyCommitResult,
  CodexTurnResultCommitResult,
  CommitCodexInputUncertaintyInput,
  CommitCodexTurnResultInput,
  CodexInputTransition,
  CreateThreadBindingInput,
  ThreadBindingCommitResult
} from "@codex-channel-bridge/profile-store";

import type { RunTurnOptions, TurnResult } from "./turn-coordinator.js";

const RESULT_SEGMENT_BYTES = 64 * 1024;

export interface ConversationTurnStore {
  getThreadBinding(key: ThreadBindingKey): Promise<ThreadBinding | undefined>;
  createThreadBinding(input: CreateThreadBindingInput): Promise<ThreadBindingCommitResult>;
  acceptCodexInput(input: CodexInputAcceptance): Promise<CodexInputCommitResult>;
  transitionCodexInput(transition: CodexInputTransition): Promise<CodexInputCorrelation>;
  commitCodexInputUncertainty(
    input: CommitCodexInputUncertaintyInput
  ): Promise<CodexInputUncertaintyCommitResult>;
  commitCodexTurnResult(input: CommitCodexTurnResultInput): Promise<CodexTurnResultCommitResult>;
}

export interface NativeTurnDriver {
  prepareThread(existingThreadId?: string): Promise<string>;
  runPreparedTurn(
    text: string,
    threadId: string,
    options?: RunTurnOptions
  ): Promise<TurnResult>;
  steerTurn(
    text: string,
    target: { readonly threadId: string; readonly turnId: string }
  ): Promise<void>;
}

export interface ConversationTurnInput {
  readonly onAnswer?: (text: string) => void;
  readonly archiveRecordId: string;
  readonly event: InboundChannelEvent;
  readonly groupThreadScope: ThreadBindingScope;
  readonly onTurnStarted?: (target: { readonly threadId: string; readonly turnId: string }) => void;
}

export interface ConversationTurnResult {
  readonly binding: ThreadBinding;
  readonly inputCorrelationId: string;
  readonly turn: TurnResult;
  readonly logicalResultId: string;
}

export interface ConversationSteerInput extends ConversationTurnInput {
  readonly target: { readonly threadId: string; readonly turnId: string };
}

export interface ConversationSteerResult {
  readonly binding: ThreadBinding;
  readonly inputCorrelationId: string;
  readonly turnId: string;
}

export interface ConversationTurnCoordinatorOptions {
  readonly prepareOutputFiles?: (text: string) => Promise<readonly LogicalResultSegmentInput[]>;
  readonly profileId: string;
  readonly store: ConversationTurnStore;
  readonly turnDriver: NativeTurnDriver;
  readonly now?: () => number;
  readonly newClientUserMessageId?: () => string;
}

/**
 * Deep Profile-local boundary for accepted Channel input. It resolves the
 * durable Binding, loads the native Codex Thread, records correlation before
 * turn/start, and durably enqueues terminal output before reporting success.
 */
export class ConversationTurnCoordinator {
  readonly #prepareOutputFiles: ConversationTurnCoordinatorOptions["prepareOutputFiles"];
  readonly #profileId: string;
  readonly #store: ConversationTurnStore;
  readonly #turnDriver: NativeTurnDriver;
  readonly #now: () => number;
  readonly #newClientUserMessageId: () => string;
  readonly #steerCorrelations = new Map<string, Set<string>>();
  readonly #terminalTurns = new Map<string, { readonly status: string; readonly atMs: number }>();

  public constructor(options: ConversationTurnCoordinatorOptions) {
    this.#prepareOutputFiles = options.prepareOutputFiles;
    this.#profileId = options.profileId;
    this.#store = options.store;
    this.#turnDriver = options.turnDriver;
    this.#now = options.now ?? Date.now;
    this.#newClientUserMessageId = options.newClientUserMessageId ?? randomUUID;
  }

  public async execute(input: ConversationTurnInput): Promise<ConversationTurnResult> {
    const text = input.event.message.text;
    if (!text?.trim()) throw new Error("Accepted Channel input requires a non-empty text body");
    if (input.event.message.profileId !== this.#profileId) {
      throw new Error("Channel input belongs to a different Profile");
    }

    const binding = await this.#resolveBinding(input.event, input.groupThreadScope);
    const clientUserMessageId = this.#newClientUserMessageId();
    const acceptance = await this.#store.acceptCodexInput({
      profileId: this.#profileId,
      archiveRecordId: input.archiveRecordId,
      bindingId: binding.bindingId,
      codexThreadId: binding.codexThreadId,
      clientUserMessageId,
      acceptedAtMs: this.#now()
    });
    if (!acceptance.inserted && acceptance.correlation.state !== "accepted") {
      throw new Error("Archived Channel input has already entered Codex processing");
    }

    let startedTurnId: string | undefined;
    try {
      const turn = await this.#turnDriver.runPreparedTurn(text, binding.codexThreadId, {
        ...(input.onAnswer ? { onAnswer: input.onAnswer } : {}),
        clientUserMessageId,
        onStarted: async (_threadId, turnId) => {
          startedTurnId = turnId;
          await this.#store.transitionCodexInput({
            correlationId: acceptance.correlation.correlationId,
            state: "started",
            codexTurnId: turnId,
            updatedAtMs: this.#now()
          });
          input.onTurnStarted?.({ threadId: binding.codexThreadId, turnId });
        }
      });
      const completedAtMs = this.#now();
      const files = turn.status === "completed" && this.#prepareOutputFiles
        ? await this.#prepareOutputFiles(turn.finalText).catch(() => [{ text: "Linked files could not be prepared for delivery." }])
        : [];
      const terminal = await this.#store.commitCodexTurnResult({
        correlationId: acceptance.correlation.correlationId,
        terminalStatus: turn.status,
        updatedAtMs: completedAtMs,
        result: {
          profileId: this.#profileId,
          codexThreadId: turn.threadId,
          codexTurnId: turn.turnId,
          provider: input.event.message.provider,
          channelAccountId: input.event.message.channelAccountId,
          channelAccountEpochId: input.event.message.channelAccountEpochId,
          target: input.event.replyTarget,
          completedAtMs,
          segments: [...splitResult(turn.finalText || `Codex Turn ended with status: ${turn.status}`,
            input.event.message.provider === "qq" ? 5_000 : Infinity), ...files]
        }
      });
      this.#rememberTerminalTurn(turn.turnId, turn.status, completedAtMs);
      await this.#completeSteerCorrelations(turn.turnId, turn.status, completedAtMs);
      return {
        binding,
        inputCorrelationId: acceptance.correlation.correlationId,
        turn,
        logicalResultId: terminal.logicalResult.logicalResultId
      };
    } catch (error) {
      const reasonCode = startedTurnId ? "turn_result_uncertain" : "turn_start_uncertain";
      await this.#store
        .commitCodexInputUncertainty({
          correlationId: acceptance.correlation.correlationId,
          reasonCode,
          completedAtMs: this.#now(),
          text: uncertainResultText(reasonCode)
        })
        .catch(() => undefined);
      throw error;
    }
  }

  public async steer(input: ConversationSteerInput): Promise<ConversationSteerResult> {
    const text = input.event.message.text;
    if (!text?.trim()) throw new Error("Steer input requires a non-empty text body");
    const key = threadBindingKeyFor(input.event, input.groupThreadScope);
    const binding = await this.#store.getThreadBinding(key);
    if (!binding || binding.codexThreadId !== input.target.threadId) {
      throw new Error("Steer target does not match the current Thread Binding");
    }
    const clientUserMessageId = this.#newClientUserMessageId();
    const acceptance = await this.#store.acceptCodexInput({
      profileId: this.#profileId,
      archiveRecordId: input.archiveRecordId,
      bindingId: binding.bindingId,
      codexThreadId: binding.codexThreadId,
      clientUserMessageId,
      acceptedAtMs: this.#now()
    });
    try {
      await this.#turnDriver.steerTurn(text, input.target);
      await this.#store.transitionCodexInput({
        correlationId: acceptance.correlation.correlationId,
        state: "started",
        codexTurnId: input.target.turnId,
        updatedAtMs: this.#now()
      });
      const terminal = this.#terminalTurns.get(input.target.turnId);
      if (terminal) {
        await this.#store.transitionCodexInput({
          correlationId: acceptance.correlation.correlationId,
          state: "terminal",
          codexTurnId: input.target.turnId,
          terminalStatus: terminal.status,
          updatedAtMs: terminal.atMs
        });
        return {
          binding,
          inputCorrelationId: acceptance.correlation.correlationId,
          turnId: input.target.turnId
        };
      }
      const correlations = this.#steerCorrelations.get(input.target.turnId) ?? new Set<string>();
      correlations.add(acceptance.correlation.correlationId);
      this.#steerCorrelations.set(input.target.turnId, correlations);
      return {
        binding,
        inputCorrelationId: acceptance.correlation.correlationId,
        turnId: input.target.turnId
      };
    } catch (error) {
      await this.#store
        .commitCodexInputUncertainty({
          correlationId: acceptance.correlation.correlationId,
          reasonCode: "turn_steer_uncertain",
          completedAtMs: this.#now(),
          text: uncertainResultText("turn_steer_uncertain")
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async #resolveBinding(
    event: InboundChannelEvent,
    groupThreadScope: ThreadBindingScope
  ): Promise<ThreadBinding> {
    const key = threadBindingKeyFor(event, groupThreadScope);
    const existing = await this.#store.getThreadBinding(key);
    if (existing) {
      await this.#turnDriver.prepareThread(existing.codexThreadId);
      return existing;
    }

    const newThreadId = await this.#turnDriver.prepareThread();
    const committed = await this.#store.createThreadBinding({
      profileId: this.#profileId,
      ...key,
      codexThreadId: newThreadId,
      boundAtMs: this.#now()
    });
    if (committed.binding.codexThreadId !== newThreadId) {
      await this.#turnDriver.prepareThread(committed.binding.codexThreadId);
    }
    return committed.binding;
  }

  async #completeSteerCorrelations(
    turnId: string,
    terminalStatus: string,
    updatedAtMs: number
  ): Promise<void> {
    const correlations = this.#steerCorrelations.get(turnId);
    if (!correlations) return;
    this.#steerCorrelations.delete(turnId);
    await Promise.all(
      [...correlations].map((correlationId) =>
        this.#store.transitionCodexInput({
          correlationId,
          state: "terminal",
          codexTurnId: turnId,
          terminalStatus,
          updatedAtMs
        })
      )
    );
  }

  #rememberTerminalTurn(turnId: string, status: string, atMs: number): void {
    this.#terminalTurns.set(turnId, { status, atMs });
    while (this.#terminalTurns.size > 1_000) {
      const oldest = this.#terminalTurns.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#terminalTurns.delete(oldest);
    }
  }
}

function uncertainResultText(reasonCode: string): string {
  const operation = reasonCode === "turn_steer_uncertain" ? "steer operation" : "Codex operation";
  return `The ${operation} outcome could not be verified. The input was not replayed automatically. You may retry or continue deliberately.`;
}

export function threadBindingKeyFor(
  event: InboundChannelEvent,
  groupThreadScope: ThreadBindingScope
): ThreadBindingKey {
  const participantScoped =
    event.message.conversationKind === "group" && groupThreadScope === "participant";
  return {
    conversationKey: event.message.conversationKey,
    scope: participantScoped ? "participant" : "conversation",
    ...(participantScoped ? { providerIdentity: event.message.providerIdentity } : {})
  };
}

function splitResult(text: string, maxCharacters: number): readonly { readonly text: string }[] {
  const segments: Array<{ text: string }> = [];
  let current = "";
  let currentBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if ((currentBytes + bytes > RESULT_SEGMENT_BYTES || current.length + character.length > maxCharacters) && current) {
      segments.push({ text: current });
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current) segments.push({ text: current });
  return segments;
}
