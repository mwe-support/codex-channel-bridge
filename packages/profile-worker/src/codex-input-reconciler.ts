import type {
  ManagedCodexRpcRuntime,
  ThreadReadResponse,
  ThreadResumeResponse
} from "@codex-channel-bridge/codex-app-server";
import type { CodexInputCorrelation } from "@codex-channel-bridge/core";
import {
  ProfileStoreError,
  type CodexInputUncertaintyCommitResult,
  type CommitCodexInputUncertaintyInput
} from "@codex-channel-bridge/profile-store";

export interface CodexInputReconciliationStore {
  nonterminalCodexInputs(): Promise<readonly CodexInputCorrelation[]>;
  commitCodexInputUncertainty(
    input: CommitCodexInputUncertaintyInput
  ): Promise<CodexInputUncertaintyCommitResult>;
}

export interface CodexInputReconciliationResult {
  readonly inspected: number;
  readonly uncertain: number;
  readonly terminalObserved: number;
  readonly missing: number;
  readonly settledElsewhere: number;
}

/** Reconciles durable Bridge correlation against Codex-owned Thread state without replaying input. */
export class CodexInputReconciler {
  readonly #runtime: ManagedCodexRpcRuntime;
  readonly #store: CodexInputReconciliationStore;
  readonly #now: () => number;

  public constructor(
    runtime: ManagedCodexRpcRuntime,
    store: CodexInputReconciliationStore,
    now: () => number = Date.now
  ) {
    this.#runtime = runtime;
    this.#store = store;
    this.#now = now;
  }

  public async reconcile(): Promise<CodexInputReconciliationResult> {
    const correlations = await this.#store.nonterminalCodexInputs();
    const threads = new Map<string, Promise<ThreadReadResponse | null>>();
    let terminalObserved = 0;
    let missing = 0;
    let settledElsewhere = 0;

    for (const correlation of correlations) {
      let reasonCode = "turn_start_uncertain";
      if (correlation.state === "started" && correlation.codexTurnId) {
        const thread = await this.#readThreadOnce(correlation.codexThreadId, threads);
        const turn = thread?.thread.turns.find((candidate) => candidate.id === correlation.codexTurnId);
        if (!thread || !turn) {
          reasonCode = "turn_missing_after_restart";
          missing += 1;
        } else if (turn.status === "inProgress") {
          reasonCode = "turn_result_uncertain";
        } else {
          // Terminal Codex state is evidence, but without an atomically committed
          // Logical Result the Bridge cannot claim delivery or reconstruct it here.
          reasonCode = "turn_result_uncommitted";
          terminalObserved += 1;
        }
      }
      try {
        await this.#store.commitCodexInputUncertainty({
          correlationId: correlation.correlationId,
          reasonCode,
          completedAtMs: this.#now(),
          text: uncertaintyMessage(reasonCode)
        });
      } catch (error) {
        if (!(error instanceof ProfileStoreError) || error.reason !== "codex_input_conflict") {
          throw error;
        }
        settledElsewhere += 1;
      }
    }

    return {
      inspected: correlations.length,
      uncertain: correlations.length - settledElsewhere,
      terminalObserved,
      missing,
      settledElsewhere
    };
  }

  #readThreadOnce(
    threadId: string,
    cache: Map<string, Promise<ThreadReadResponse | null>>
  ): Promise<ThreadReadResponse | null> {
    const existing = cache.get(threadId);
    if (existing) return existing;
    const read = this.#resumeAndRead(threadId);
    cache.set(threadId, read);
    return read;
  }

  async #resumeAndRead(threadId: string): Promise<ThreadReadResponse | null> {
    try {
      const resumed = await this.#runtime.request<ThreadResumeResponse>("thread/resume", {
        threadId
      });
      if (resumed.thread.id !== threadId) return null;
      const response = await this.#runtime.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: true
      });
      return response.thread.id === threadId ? response : null;
    } catch {
      return null;
    }
  }
}

function uncertaintyMessage(reasonCode: string): string {
  const detail =
    reasonCode === "turn_result_uncommitted"
      ? "Codex reached a terminal state, but the Bridge could not verify a committed result."
      : reasonCode === "turn_missing_after_restart"
        ? "The previously associated Codex Turn could not be found after restart."
        : "The Codex operation outcome could not be verified after restart.";
  return `${detail} The input was not replayed automatically. You may retry or continue deliberately.`;
}
