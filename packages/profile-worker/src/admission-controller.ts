export type AdmissionMode = "steer" | "queue";

export interface ActiveTurnTarget {
  readonly threadId: string;
  readonly turnId: string;
}

export interface AdmissionRequest {
  readonly workId: string;
  readonly channelAccountId: string;
  readonly threadKey: string;
  readonly providerIdentity: string;
  readonly receivedAtMs: number;
}

export type AdmissionDisposition =
  | { readonly kind: "start"; readonly workId: string }
  | { readonly kind: "steer"; readonly workId: string; readonly target: ActiveTurnTarget }
  | { readonly kind: "queued"; readonly workId: string; readonly position: number }
  | {
      readonly kind: "rejected";
      readonly workId: string;
      readonly reason: "unavailable" | "busy" | "rate_limited" | "duplicate";
    };

export interface AdmissionDecision {
  readonly disposition: AdmissionDisposition;
  readonly expired: readonly ExpiredAdmission[];
}

export interface ExpiredAdmission {
  readonly workId: string;
  readonly reason: "expired" | "unavailable";
}

export interface AdmissionRelease {
  readonly ready: readonly AdmissionRequest[];
  readonly expired: readonly ExpiredAdmission[];
}

export interface AdmissionControllerOptions {
  readonly mode: AdmissionMode;
  readonly maximumActiveTurns: number | null;
  readonly queueCapacity: number;
  readonly maximumQueueAgeMs: number;
  readonly accountRateLimit: number;
  readonly accountRateWindowMs: number;
  readonly ready?: boolean;
}

/** Profile-local, in-memory admission for ordinary Channel input only. */
export class AdmissionController {
  readonly #options: AdmissionControllerOptions;
  readonly #active = new Map<
    string,
    {
      readonly threadKey: string;
      readonly initiatorIdentity: string;
      target?: ActiveTurnTarget;
    }
  >();
  readonly #queue: AdmissionRequest[] = [];
  readonly #rateWindows = new Map<string, number[]>();
  #ready: boolean;

  public constructor(options: AdmissionControllerOptions) {
    validateOptions(options);
    this.#options = options;
    this.#ready = options.ready ?? false;
  }

  public admit(request: AdmissionRequest): AdmissionDecision {
    validateRequest(request);
    const expired = this.#expire(request.receivedAtMs);
    if (this.#contains(request.workId)) {
      return {
        disposition: { kind: "rejected", workId: request.workId, reason: "duplicate" },
        expired
      };
    }
    if (!this.#ready) {
      return {
        disposition: { kind: "rejected", workId: request.workId, reason: "unavailable" },
        expired
      };
    }
    if (!this.#takeRate(request.channelAccountId, request.receivedAtMs)) {
      return {
        disposition: { kind: "rejected", workId: request.workId, reason: "rate_limited" },
        expired
      };
    }
    const activeThread = this.#activeForThread(request.threadKey);
    if (activeThread) {
      if (
        this.#options.mode === "steer" &&
        activeThread.initiatorIdentity === request.providerIdentity &&
        activeThread.target
      ) {
        return {
          disposition: { kind: "steer", workId: request.workId, target: activeThread.target },
          expired
        };
      }
      return {
        disposition:
          this.#options.mode === "queue"
            ? this.#enqueue(request)
            : { kind: "rejected", workId: request.workId, reason: "busy" },
        expired
      };
    }
    if (this.#active.size < (this.#options.maximumActiveTurns ?? Infinity)) {
      this.#active.set(request.workId, {
        threadKey: request.threadKey,
        initiatorIdentity: request.providerIdentity
      });
      return { disposition: { kind: "start", workId: request.workId }, expired };
    }
    if (this.#options.mode === "queue") {
      return { disposition: this.#enqueue(request), expired };
    }
    return {
      disposition: { kind: "rejected", workId: request.workId, reason: "busy" },
      expired
    };
  }

  public release(workId: string, nowMs: number): AdmissionRelease {
    validateTime(nowMs);
    this.#active.delete(workId);
    const expired = this.#expire(nowMs);
    const ready: AdmissionRequest[] = [];
    // ponytail: O(queue * active) scan; add a Thread index if measured admission cost warrants it.
    for (let index = 0;
      index < this.#queue.length &&
      this.#active.size < (this.#options.maximumActiveTurns ?? Infinity);
    ) {
      const candidate = this.#queue[index]!;
      if (this.#activeForThread(candidate.threadKey)) {
        index += 1;
        continue;
      }
      this.#queue.splice(index, 1);
      this.#active.set(candidate.workId, {
        threadKey: candidate.threadKey,
        initiatorIdentity: candidate.providerIdentity
      });
      ready.push(candidate);
    }
    return { ready, expired };
  }

  public setReady(ready: boolean, nowMs: number): AdmissionRelease {
    validateTime(nowMs);
    this.#ready = ready;
    const expired = this.#expire(nowMs);
    if (ready) return { ready: [], expired };
    expired.push(...this.#queue.splice(0).map((entry) => ({
      workId: entry.workId,
      reason: "unavailable" as const
    })));
    return { ready: [], expired };
  }

  public expire(nowMs: number): readonly ExpiredAdmission[] {
    validateTime(nowMs);
    return this.#expire(nowMs);
  }

  public snapshot(): { readonly active: number; readonly queued: number; readonly ready: boolean } {
    return { active: this.#active.size, queued: this.#queue.length, ready: this.#ready };
  }

  public markTurnStarted(workId: string, target: ActiveTurnTarget): void {
    const active = this.#active.get(workId);
    if (!active) throw new Error("Admission work is not active");
    active.target = target;
  }

  public activeTurnFor(
    threadKey: string,
    providerIdentity: string
  ):
    | { readonly kind: "none" }
    | { readonly kind: "forbidden" }
    | { readonly kind: "allowed"; readonly target: ActiveTurnTarget } {
    const active = this.#activeForThread(threadKey);
    if (!active?.target) return { kind: "none" };
    return active.initiatorIdentity === providerIdentity
      ? { kind: "allowed", target: active.target }
      : { kind: "forbidden" };
  }

  #enqueue(request: AdmissionRequest): AdmissionDisposition {
    if (this.#queue.length >= this.#options.queueCapacity) {
      return { kind: "rejected", workId: request.workId, reason: "busy" };
    }
    this.#queue.push(request);
    return { kind: "queued", workId: request.workId, position: this.#queue.length };
  }

  #expire(nowMs: number): ExpiredAdmission[] {
    const expired: ExpiredAdmission[] = [];
    for (let index = 0; index < this.#queue.length; ) {
      const entry = this.#queue[index]!;
      if (nowMs - entry.receivedAtMs <= this.#options.maximumQueueAgeMs) {
        index += 1;
        continue;
      }
      this.#queue.splice(index, 1);
      expired.push({ workId: entry.workId, reason: "expired" });
    }
    return expired;
  }

  #takeRate(channelAccountId: string, nowMs: number): boolean {
    const earliest = nowMs - this.#options.accountRateWindowMs;
    const current = (this.#rateWindows.get(channelAccountId) ?? []).filter(
      (time) => time > earliest
    );
    if (current.length >= this.#options.accountRateLimit) {
      this.#rateWindows.set(channelAccountId, current);
      return false;
    }
    current.push(nowMs);
    this.#rateWindows.set(channelAccountId, current);
    return true;
  }

  #contains(workId: string): boolean {
    return this.#active.has(workId) || this.#queue.some((entry) => entry.workId === workId);
  }

  #activeForThread(
    threadKey: string
  ):
    | {
        readonly threadKey: string;
        readonly initiatorIdentity: string;
        target?: ActiveTurnTarget;
      }
    | undefined {
    return [...this.#active.values()].find((active) => active.threadKey === threadKey);
  }
}

function validateOptions(options: AdmissionControllerOptions): void {
  const positive = [
    options.maximumQueueAgeMs,
    options.accountRateLimit,
    options.accountRateWindowMs
  ].every((value) => Number.isSafeInteger(value) && value > 0);
  if (
    !positive ||
    (options.maximumActiveTurns !== null &&
      (!Number.isSafeInteger(options.maximumActiveTurns) || options.maximumActiveTurns < 1)) ||
    !Number.isSafeInteger(options.queueCapacity) ||
    options.queueCapacity < 0 ||
    (options.mode !== "steer" && options.mode !== "queue")
  ) {
    throw new RangeError("Admission Controller options are invalid");
  }
}

function validateRequest(request: AdmissionRequest): void {
  if (
    !request.workId ||
    !request.channelAccountId ||
    !request.threadKey ||
    !request.providerIdentity
  ) {
    throw new TypeError("Admission request identifiers must be non-empty");
  }
  validateTime(request.receivedAtMs);
}

function validateTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Admission time is invalid");
}
