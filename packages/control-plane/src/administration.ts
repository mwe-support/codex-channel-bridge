import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  ConfigurationValidationError,
  loadConfiguration,
  type ConfigurationCandidate
} from "@codex-channel-bridge/config";
import {
  ProfileMigrationError,
  applyProfileStoreMigration,
  planProfileStoreMigration,
  type ProfileMigrationPlan
} from "@codex-channel-bridge/profile-store";
import type { Supervisor } from "@codex-channel-bridge/supervisor";

import {
  asRecord,
  type AdministrationRequest,
  type ConfigurationPlanResult,
  type MigrationPlanResult
} from "./protocol.js";
import { readMigrationBackupManifest } from "./migration-backup.js";

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

interface PendingMigrationPlan {
  readonly result: MigrationPlanResult;
  readonly plan: ProfileMigrationPlan;
}

export class SupervisorAdministration implements AdministrationHandler {
  readonly #supervisor: Supervisor;
  readonly #planLifetimeMs: number;
  readonly #now: () => number;
  readonly #loadCandidate: (absolutePath: string) => Promise<ConfigurationCandidate>;
  readonly #plans = new Map<string, PendingPlan>();
  readonly #migrationPlans = new Map<string, PendingMigrationPlan>();

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
    if (request.method === "config/apply") return this.#apply(request.params);
    if (request.method === "migrate/plan") return this.#planMigration(request.params);
    return this.#applyMigration(request.params);
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

  async #planMigration(params: unknown): Promise<MigrationPlanResult> {
    const record = asRecord(params);
    if (!record || typeof record.profileId !== "string") {
      throw new AdministrationError("invalid_params", "migrate/plan requires profileId");
    }
    const configurationRevision = this.#supervisor.status().configurationRevision;
    const profile = this.#supervisor.profileConfiguration(record.profileId);
    if (!configurationRevision || !profile) {
      throw new AdministrationError("profile_not_found", "Profile is not configured");
    }
    let plan: ProfileMigrationPlan;
    try {
      plan = await planProfileStoreMigration(migrationTarget(profile));
    } catch (error) {
      throw migrationAdministrationError(error);
    }
    const planToken = randomUUID();
    const result: MigrationPlanResult = {
      ...plan,
      planToken,
      configurationRevision,
      expiresAt: this.#now() + this.#planLifetimeMs,
      requiredBackupManifest: {
        schemaVersion: 1,
        kind: "codex-channel-bridge-profile-snapshot",
        profileId: plan.profileId,
        sourceDigest: plan.sourceDigest,
        completedAtMs: "POSITIVE_INTEGER"
      }
    };
    this.#migrationPlans.set(planToken, { result, plan });
    return result;
  }

  async #applyMigration(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (
      !record ||
      typeof record.planToken !== "string" ||
      typeof record.confirmPlanDigest !== "string" ||
      typeof record.backupManifestPath !== "string" ||
      record.snapshotConfirmed !== true
    ) {
      throw new AdministrationError(
        "invalid_params",
        "migrate/apply requires planToken, confirmPlanDigest, backupManifestPath, and snapshotConfirmed=true"
      );
    }
    const pending = this.#migrationPlans.get(record.planToken);
    this.#migrationPlans.delete(record.planToken);
    if (!pending || pending.result.expiresAt < this.#now()) {
      throw new AdministrationError("plan_expired", "Migration plan is absent or expired");
    }
    if (record.confirmPlanDigest !== pending.plan.planDigest) {
      throw new AdministrationError("confirmation_mismatch", "Full migration plan digest did not match");
    }
    if (this.#supervisor.status().configurationRevision !== pending.result.configurationRevision) {
      throw new AdministrationError("plan_stale", "Configuration Revision changed after planning");
    }
    if (!pending.plan.migrationRequired) {
      throw new AdministrationError("migration_not_required", "Profile schema is already current");
    }

    try {
      return await this.#supervisor.maintainProfile(pending.plan.profileId, async (profile) => {
        const target = migrationTarget(profile);
        const current = await planProfileStoreMigration(target);
        if (
          current.planDigest !== pending.plan.planDigest ||
          current.sourceDigest !== pending.plan.sourceDigest
        ) {
          throw new ProfileMigrationError("source_changed", "Profile store changed after planning");
        }
        await readMigrationBackupManifest(record.backupManifestPath as string, {
          profileId: pending.plan.profileId,
          sourceDigest: pending.plan.sourceDigest
        });
        return applyProfileStoreMigration({
          ...target,
          expectedPlanDigest: pending.plan.planDigest,
          expectedSourceDigest: pending.plan.sourceDigest,
          nowMs: this.#now()
        });
      });
    } catch (error) {
      throw migrationAdministrationError(error);
    }
  }

  #expirePlans(): void {
    const now = this.#now();
    for (const [token, plan] of this.#plans) {
      if (plan.result.expiresAt < now) this.#plans.delete(token);
    }
    for (const [token, plan] of this.#migrationPlans) {
      if (plan.result.expiresAt < now) this.#migrationPlans.delete(token);
    }
  }
}

function migrationTarget(profile: { readonly id: string; readonly stateDirectory: string }) {
  return {
    profileId: profile.id,
    databasePath: join(profile.stateDirectory, "bridge.sqlite"),
    auditPath: join(profile.stateDirectory, "migration-audit.jsonl")
  };
}

function migrationAdministrationError(error: unknown): AdministrationError {
  if (error instanceof AdministrationError) return error;
  if (error instanceof ProfileMigrationError) {
    return new AdministrationError(`migration_${error.reason}`, error.message);
  }
  if (error instanceof Error && error.message.startsWith("Profile ")) {
    return new AdministrationError("profile_not_quiescent", error.message);
  }
  return new AdministrationError("migration_failed", "Profile migration operation failed");
}
