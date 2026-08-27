import type { JsonRpcNotification } from "@codex-channel-bridge/codex-app-server";

const DEFAULT_MAX_BUFFERED_SIGNALS = 1_000;

export type CodexEventRouterErrorCode =
  | "router_closed"
  | "thread_already_registered"
  | "notification_buffer_overflow"
  | "turn_already_claimed";

export class CodexEventRouterError extends Error {
  public constructor(
    public readonly code: CodexEventRouterErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CodexEventRouterError";
  }
}

export interface RoutedTurnTerminal {
  readonly turnId: string;
  readonly status: string;
  readonly agentMessages: readonly string[];
}

export interface CodexTurnRegistration {
  readonly threadId: string;
  readonly completion: Promise<RoutedTurnTerminal>;
  claim(turnId: string): void;
  cancel(reason: Error): void;
}

export interface CodexEventRouterOptions {
  readonly maxBufferedSignals?: number;
}

type TurnSignal =
  | { readonly kind: "agent_message"; readonly text: string }
  | { readonly kind: "completed"; readonly status: string };

interface RoutedSignal {
  readonly threadId: string;
  readonly turnId: string;
  readonly signal: TurnSignal;
}

interface TurnSlot {
  readonly threadId: string;
  readonly completion: Promise<RoutedTurnTerminal>;
  readonly resolve: (result: RoutedTurnTerminal) => void;
  readonly reject: (reason: Error) => void;
  readonly bufferedByTurn: Map<string, TurnSignal[]>;
  readonly agentMessages: string[];
  bufferedSignalCount: number;
  claimedTurnId?: string;
  settled: boolean;
}

export class CodexEventRouter {
  readonly #maxBufferedSignals: number;
  readonly #slotsByThread = new Map<string, TurnSlot>();
  readonly #activeByKey = new Map<string, TurnSlot>();
  #closedError?: Error;

  public constructor(options: CodexEventRouterOptions = {}) {
    const maxBufferedSignals = options.maxBufferedSignals ?? DEFAULT_MAX_BUFFERED_SIGNALS;
    if (!Number.isSafeInteger(maxBufferedSignals) || maxBufferedSignals < 1) {
      throw new RangeError("maxBufferedSignals must be a positive safe integer");
    }
    this.#maxBufferedSignals = maxBufferedSignals;
  }

  public beginTurn(threadId: string): CodexTurnRegistration {
    if (this.#closedError) {
      throw new CodexEventRouterError("router_closed", this.#closedError.message);
    }
    if (this.#slotsByThread.has(threadId)) {
      throw new CodexEventRouterError(
        "thread_already_registered",
        `Thread ${threadId} already has a pending or active Turn`
      );
    }

    let resolve!: (result: RoutedTurnTerminal) => void;
    let reject!: (reason: Error) => void;
    const completion = new Promise<RoutedTurnTerminal>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // A turn/start request can fail before its caller awaits completion. Mark the
    // deferred as observed while preserving rejection for consumers of the
    // original Promise.
    void completion.catch(() => undefined);

    const slot: TurnSlot = {
      threadId,
      completion,
      resolve,
      reject,
      bufferedByTurn: new Map(),
      agentMessages: [],
      bufferedSignalCount: 0,
      settled: false
    };
    this.#slotsByThread.set(threadId, slot);

    return {
      threadId,
      completion,
      claim: (turnId) => this.#claim(slot, turnId),
      cancel: (reason) => this.#reject(slot, reason)
    };
  }

  public route(message: JsonRpcNotification): void {
    const routed = routeSignal(message);
    if (!routed || this.#closedError) return;

    const active = this.#activeByKey.get(turnKey(routed.threadId, routed.turnId));
    if (active) {
      this.#apply(active, routed.signal);
      return;
    }

    const pending = this.#slotsByThread.get(routed.threadId);
    if (!pending || pending.claimedTurnId || pending.settled) return;
    if (pending.bufferedSignalCount >= this.#maxBufferedSignals) {
      this.#reject(
        pending,
        new CodexEventRouterError(
          "notification_buffer_overflow",
          `Buffered Codex Turn signals exceeded ${this.#maxBufferedSignals}`
        )
      );
      return;
    }

    const signals = pending.bufferedByTurn.get(routed.turnId) ?? [];
    signals.push(routed.signal);
    pending.bufferedByTurn.set(routed.turnId, signals);
    pending.bufferedSignalCount += 1;
  }

  public close(reason: Error = new Error("Codex Event Router closed")): void {
    if (this.#closedError) return;
    this.#closedError = reason;
    for (const slot of [...this.#slotsByThread.values()]) this.#reject(slot, reason);
  }

  #claim(slot: TurnSlot, turnId: string): void {
    if (slot.settled) return;
    if (slot.claimedTurnId) {
      throw new CodexEventRouterError(
        "turn_already_claimed",
        `Thread ${slot.threadId} already claimed Turn ${slot.claimedTurnId}`
      );
    }
    slot.claimedTurnId = turnId;
    this.#activeByKey.set(turnKey(slot.threadId, turnId), slot);

    const buffered = slot.bufferedByTurn.get(turnId) ?? [];
    slot.bufferedByTurn.clear();
    slot.bufferedSignalCount = 0;
    for (const signal of buffered) {
      if (slot.settled) break;
      this.#apply(slot, signal);
    }
  }

  #apply(slot: TurnSlot, signal: TurnSignal): void {
    if (slot.settled || !slot.claimedTurnId) return;
    if (signal.kind === "agent_message") {
      slot.agentMessages.push(signal.text);
      return;
    }
    slot.settled = true;
    const terminal: RoutedTurnTerminal = {
      turnId: slot.claimedTurnId,
      status: signal.status,
      agentMessages: [...slot.agentMessages]
    };
    this.#cleanup(slot);
    slot.resolve(terminal);
  }

  #reject(slot: TurnSlot, reason: Error): void {
    if (slot.settled) return;
    slot.settled = true;
    this.#cleanup(slot);
    slot.reject(reason);
  }

  #cleanup(slot: TurnSlot): void {
    if (this.#slotsByThread.get(slot.threadId) === slot) {
      this.#slotsByThread.delete(slot.threadId);
    }
    if (slot.claimedTurnId) {
      const key = turnKey(slot.threadId, slot.claimedTurnId);
      if (this.#activeByKey.get(key) === slot) this.#activeByKey.delete(key);
    }
    slot.bufferedByTurn.clear();
    slot.bufferedSignalCount = 0;
  }
}

function routeSignal(message: JsonRpcNotification): RoutedSignal | null {
  const params = asRecord(message.params);
  if (!params || typeof params.threadId !== "string") return null;

  if (message.method === "item/completed") {
    if (typeof params.turnId !== "string") return null;
    const item = asRecord(params.item);
    if (item?.type !== "agentMessage" || typeof item.text !== "string") return null;
    return {
      threadId: params.threadId,
      turnId: params.turnId,
      signal: { kind: "agent_message", text: item.text }
    };
  }

  if (message.method === "turn/completed") {
    const turn = asRecord(params.turn);
    if (!turn || typeof turn.id !== "string") return null;
    return {
      threadId: params.threadId,
      turnId: turn.id,
      signal: {
        kind: "completed",
        status: typeof turn.status === "string" ? turn.status : "unknown"
      }
    };
  }

  return null;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
