import { randomUUID } from "node:crypto";

import {
  ConfigurationValidationError,
  loadConfiguration,
  type ConfigurationCandidate
} from "@codex-channel-bridge/config";
import type { Supervisor } from "@codex-channel-bridge/supervisor";

import {
  asRecord,
  type AdministrationRequest,
  type ConfigurationPlanResult
} from "./protocol.js";

export interface AdministrationHandler {
  handle(request: AdministrationRequest): Promise<unknown>;
}

export class AdministrationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "AdministrationError";
  }
}

export interface AdministrationOptions {
  readonly planLifetimeMs?: number;
  readonly now?: () => number;
  readonly loadCandidate?: (absolutePath: string) => Promise<ConfigurationCandidate>;
}

interface PendingPlan {
  readonly result: ConfigurationPlanResult;
  readonly candidate: ConfigurationCandidate;
}

export class SupervisorAdministration implements AdministrationHandler {
  readonly #supervisor: Supervisor;
  readonly #planLifetimeMs: number;
  readonly #now: () => number;
  readonly #loadCandidate: (absolutePath: string) => Promise<ConfigurationCandidate>;
  readonly #plans = new Map<string, PendingPlan>();

  public constructor(supervisor: Supervisor, options: AdministrationOptions = {}) {
    this.#supervisor = supervisor;
    this.#planLifetimeMs = options.planLifetimeMs ?? 5 * 60_000;
    this.#now = options.now ?? (() => Date.now());
    this.#loadCandidate = options.loadCandidate ?? ((path) => loadConfiguration(path));
  }

  public async handle(request: AdministrationRequest): Promise<unknown> {
    this.#expirePlans();
    if (request.method === "status/get") return this.#supervisor.status();
    if (request.method === "config/plan") return this.#plan(request.params);
    return this.#apply(request.params);
  }

  async #plan(params: unknown): Promise<ConfigurationPlanResult> {
    const record = asRecord(params);
    if (!record || typeof record.configPath !== "string") {
      throw new AdministrationError("invalid_params", "config/plan requires configPath");
    }
    let candidate: ConfigurationCandidate;
    try {
      candidate = await this.#loadCandidate(record.configPath);
    } catch (error) {
      if (error instanceof ConfigurationValidationError) {
        throw new AdministrationError("invalid_configuration", error.message, {
          issues: error.issues
        });
      }
      throw error;
    }
    const preview = this.#supervisor.preview(candidate);
    const planToken = randomUUID();
    const result: ConfigurationPlanResult = {
      planToken,
      previousRevision: preview.previousRevision,
      candidateRevision: preview.candidateRevision,
      entries: preview.entries,
      expiresAt: this.#now() + this.#planLifetimeMs
    };
    this.#plans.set(planToken, { result, candidate });
    return result;
  }

  async #apply(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (
      !record ||
      typeof record.planToken !== "string" ||
      typeof record.confirmRevision !== "string"
    ) {
      throw new AdministrationError(
        "invalid_params",
        "config/apply requires planToken and confirmRevision"
      );
    }
    const plan = this.#plans.get(record.planToken);
    this.#plans.delete(record.planToken);
    if (!plan || plan.result.expiresAt < this.#now()) {
      throw new AdministrationError("plan_expired", "Configuration plan is absent or expired");
    }
    if (record.confirmRevision !== plan.result.candidateRevision) {
      throw new AdministrationError("confirmation_mismatch", "Full candidate revision did not match");
    }
    if (this.#supervisor.status().configurationRevision !== plan.result.previousRevision) {
      throw new AdministrationError("plan_stale", "Current Configuration Revision changed after planning");
    }
    return this.#supervisor.apply(plan.candidate);
  }

  #expirePlans(): void {
    const now = this.#now();
    for (const [token, plan] of this.#plans) {
      if (plan.result.expiresAt < now) this.#plans.delete(token);
    }
  }
}
