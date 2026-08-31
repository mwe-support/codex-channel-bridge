const DEFAULT_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const DEFAULT_COOLDOWN_MS = 30_000;

export interface CodexRestartControllerOptions {
  readonly delaysMs?: readonly number[];
  readonly cooldownMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
}

/**
 * Owns the bounded restart budget and circuit cooldown. The caller supplies one
 * generation attempt; scheduling, coalescing, jitter, and cancellation stay
 * behind this interface.
 */
export class CodexRestartController {
  readonly #delaysMs: readonly number[];
  readonly #cooldownMs: number;
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #random: () => number;
  #running?: Promise<boolean>;
  #stopped = false;

  public constructor(options: CodexRestartControllerOptions = {}) {
    this.#delaysMs = options.delaysMs ?? DEFAULT_DELAYS_MS;
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#sleep = options.sleep ?? backgroundDelay;
    this.#random = options.random ?? Math.random;
    if (
      this.#delaysMs.length === 0 ||
      this.#delaysMs.some((delayMs) => !Number.isSafeInteger(delayMs) || delayMs < 0) ||
      !Number.isSafeInteger(this.#cooldownMs) ||
      this.#cooldownMs < 1
    ) {
      throw new RangeError("Codex restart policy is invalid");
    }
  }

  public recover(
    attempt: () => Promise<boolean>,
    onCircuitOpen: () => void
  ): Promise<boolean> {
    if (this.#stopped) return Promise.resolve(false);
    if (this.#running) return this.#running;
    const running = this.#run(attempt, onCircuitOpen);
    this.#running = running;
    void running.finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    return running;
  }

  public stop(): void {
    this.#stopped = true;
  }

  async #run(attempt: () => Promise<boolean>, onCircuitOpen: () => void): Promise<boolean> {
    while (!this.#stopped) {
      for (const baseDelayMs of this.#delaysMs) {
        await this.#sleep(jitteredDelay(baseDelayMs, this.#random()));
        if (this.#stopped) return false;
        try {
          if (await attempt()) return true;
        } catch {
          // A generation factory or handshake failure consumes this bounded
          // attempt exactly like a false result; it must not escape the loop.
        }
      }
      if (this.#stopped) return false;
      onCircuitOpen();
      await this.#sleep(this.#cooldownMs);
    }
    return false;
  }
}

async function backgroundDelay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

function jitteredDelay(baseDelayMs: number, random: number): number {
  const bounded = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0.5;
  return Math.max(0, Math.round(baseDelayMs * (0.8 + bounded * 0.4)));
}
