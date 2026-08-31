import { randomUUID } from "node:crypto";

import type {
  ManagedCodexRpcRuntime,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse
} from "@codex-channel-bridge/codex-app-server";
import { CodexEventRouter, type CodexTurnRegistration } from "./codex-event-router.js";

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;

export interface TurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: string;
  readonly finalText: string;
  readonly clientUserMessageId: string;
}

export interface RunTurnOptions {
  readonly clientUserMessageId?: string;
  readonly onStarted?: (threadId: string, turnId: string) => Promise<void>;
}

export interface SteerTurnTarget {
  readonly threadId: string;
  readonly turnId: string;
}

export interface TurnCoordinatorOptions {
  readonly runtime: ManagedCodexRpcRuntime;
  readonly workspace: string;
  readonly eventRouter: CodexEventRouter;
  readonly turnTimeoutMs?: number;
}

export class TurnCoordinator {
  readonly #runtime: ManagedCodexRpcRuntime;
  readonly #workspace: string;
  readonly #eventRouter: CodexEventRouter;
  readonly #turnTimeoutMs: number;
  readonly #loadedThreadIds = new Set<string>();
  readonly #activeTurns = new Map<string, SteerTurnTarget>();
  #pendingTurnStarts = 0;

  public constructor(options: TurnCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#workspace = options.workspace;
    this.#eventRouter = options.eventRouter;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#turnTimeoutMs) || this.#turnTimeoutMs < 1) {
      throw new RangeError("turnTimeoutMs must be a positive safe integer");
    }
  }

  public async runTurn(
    text: string,
    existingThreadId?: string,
    options: RunTurnOptions = {}
  ): Promise<TurnResult> {
    const threadId = await this.prepareThread(existingThreadId);
    return this.runPreparedTurn(text, threadId, options);
  }

  public async prepareThread(existingThreadId?: string): Promise<string> {
    return existingThreadId
      ? this.#resumeThread(existingThreadId)
      : this.#startThread();
  }

  public async runPreparedTurn(
    text: string,
    threadId: string,
    options: RunTurnOptions = {}
  ): Promise<TurnResult> {
    if (!this.#loadedThreadIds.has(threadId)) {
      throw new Error("Codex Thread must be started or resumed before turn/start");
    }
    const clientUserMessageId = options.clientUserMessageId ?? randomUUID();
    const registration = this.#eventRouter.beginTurn(threadId);
    this.#pendingTurnStarts += 1;

    try {
      const response = await this.#runtime.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        clientUserMessageId
      });
      registration.claim(response.turn.id);
      this.#activeTurns.set(turnKey(threadId, response.turn.id), {
        threadId,
        turnId: response.turn.id
      });
      await options.onStarted?.(threadId, response.turn.id);
      const terminal = await waitForTerminal(registration, this.#turnTimeoutMs);
      return {
        threadId,
        turnId: terminal.turnId,
        status: terminal.status,
        finalText: terminal.agentMessages.join("\n\n"),
        clientUserMessageId
      };
    } catch (error) {
      registration.cancel(asError(error));
      throw error;
    } finally {
      this.#pendingTurnStarts -= 1;
      for (const [key, target] of this.#activeTurns) {
        if (target.threadId === threadId) this.#activeTurns.delete(key);
      }
    }
  }

  public activeCount(): number {
    return this.#pendingTurnStarts;
  }

  public activeTargets(): readonly SteerTurnTarget[] {
    return [...this.#activeTurns.values()].map((target) => ({ ...target }));
  }

  public async interruptActiveTurns(): Promise<void> {
    await Promise.allSettled(this.activeTargets().map((target) => this.interruptTurn(target)));
  }

  public async steerTurn(text: string, target: SteerTurnTarget): Promise<void> {
    if (!this.#loadedThreadIds.has(target.threadId)) {
      throw new Error("Cannot steer a Thread that is not loaded in this App Server generation");
    }
    const response = await this.#runtime.request<TurnSteerResponse>("turn/steer", {
      threadId: target.threadId,
      input: [{ type: "text", text }],
      expectedTurnId: target.turnId
    });
    if (response.turnId !== target.turnId) {
      throw new Error("Codex steered a different Turn than requested");
    }
  }

  public async interruptTurn(target: SteerTurnTarget): Promise<void> {
    if (!this.#loadedThreadIds.has(target.threadId)) {
      throw new Error("Cannot interrupt a Thread that is not loaded in this App Server generation");
    }
    await this.#runtime.request<TurnInterruptResponse>("turn/interrupt", {
      threadId: target.threadId,
      turnId: target.turnId
    });
  }

  async #startThread(): Promise<string> {
    const response = await this.#runtime.request<ThreadStartResponse>("thread/start", {
      cwd: this.#workspace
    });
    this.#loadedThreadIds.add(response.thread.id);
    return response.thread.id;
  }

  async #resumeThread(threadId: string): Promise<string> {
    if (this.#loadedThreadIds.has(threadId)) return threadId;
    const response = await this.#runtime.request<ThreadResumeResponse>("thread/resume", {
      threadId
    });
    if (response.thread.id !== threadId) {
      throw new Error("Codex resumed a different Thread than requested");
    }
    this.#loadedThreadIds.add(threadId);
    return threadId;
  }
}

async function waitForTerminal(
  registration: CodexTurnRegistration,
  timeoutMs: number
): Promise<Awaited<CodexTurnRegistration["completion"]>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Timed out waiting for turn/completed");
      registration.cancel(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([registration.completion, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}
