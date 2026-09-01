import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  ConfigurationValidationError,
  loadConfiguration,
  type ConfigurationCandidate
} from "@codex-channel-bridge/config";
import {
  ProfileMigrationError,
  ProfileStore,
  applyProfileStoreMigration,
  planProfileStoreMigration,
  type ArchivePurgePreview,
  type ArchivePurgeScope,
  type ProfileMigrationPlan
} from "@codex-channel-bridge/profile-store";
import {
  ProfileRuntimeActionError,
  type Supervisor,
  type WhatsAppChannelAccountEvent
} from "@codex-channel-bridge/supervisor";

import {
  asRecord,
  type AdministrationRequest,
  type ConfigurationPlanResult,
  type ArchivePurgePlanResult,
  type MigrationPlanResult,
  type ProfilePurgePlanResult
} from "./protocol.js";
import { readMigrationBackupManifest } from "./migration-backup.js";
import {
  applyProfilePurge,
  planProfilePurge,
  type ProfilePurgePreview
} from "./profile-purge.js";
import { OperationsInspector } from "./operations-inspector.js";
import { BackupCoordinator } from "./backup-coordinator.js";
import { AuditManager } from "./audit-manager.js";
import { SupportBundleManager } from "./support-bundle.js";

export interface AdministrationHandler {
  handle(
    request: AdministrationRequest,
    emitEvent?: (event: WhatsAppChannelAccountEvent) => Promise<void>
  ): Promise<unknown>;
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

interface PendingArchivePurgePlan {
  readonly result: ArchivePurgePlanResult;
  readonly preview: ArchivePurgePreview;
}

interface PendingProfilePurgePlan {
  readonly result: ProfilePurgePlanResult;
  readonly preview: ProfilePurgePreview;
}

export class SupervisorAdministration implements AdministrationHandler {
  readonly #supervisor: Supervisor;
  readonly #planLifetimeMs: number;
  readonly #now: () => number;
  readonly #loadCandidate: (absolutePath: string) => Promise<ConfigurationCandidate>;
  readonly #plans = new Map<string, PendingPlan>();
  readonly #migrationPlans = new Map<string, PendingMigrationPlan>();
  readonly #archivePurgePlans = new Map<string, PendingArchivePurgePlan>();
  readonly #profilePurgePlans = new Map<string, PendingProfilePurgePlan>();
  readonly #operationsInspector: OperationsInspector;
  readonly #backupCoordinator: BackupCoordinator;
  readonly #auditManager: AuditManager;
  readonly #supportBundleManager: SupportBundleManager;

  public constructor(supervisor: Supervisor, options: AdministrationOptions = {}) {
    this.#supervisor = supervisor;
    this.#planLifetimeMs = options.planLifetimeMs ?? 5 * 60_000;
    this.#now = options.now ?? (() => Date.now());
    this.#loadCandidate = options.loadCandidate ?? ((path) => loadConfiguration(path));
    this.#operationsInspector = new OperationsInspector(supervisor, this.#now);
    this.#backupCoordinator = new BackupCoordinator(supervisor, this.#now);
    this.#auditManager = new AuditManager(supervisor, this.#now, this.#planLifetimeMs);
    this.#supportBundleManager = new SupportBundleManager(
      supervisor,
      this.#operationsInspector,
      this.#auditManager,
      this.#now,
      this.#planLifetimeMs
    );
  }

  public async handle(
    request: AdministrationRequest,
    emitEvent: (event: WhatsAppChannelAccountEvent) => Promise<void> = async () => undefined
  ): Promise<unknown> {
    this.#expirePlans();
    if (request.method === "status/get") return this.#supervisor.status();
    if (request.method === "doctor/run") return this.#doctor(request.params);
    if (request.method === "backup/prepare") return this.#prepareBackup(request.params);
    if (request.method === "backup/finish") return this.#finishBackup(request.params);
    if (request.method === "restore/validate") return this.#validateRestore(request.params);
    if (request.method === "audit/query") return this.#queryAudit(request.params);
    if (request.method === "audit/export") return this.#exportAudit(request.params);
    if (request.method === "audit/retention-plan") return this.#planAuditRetention(request.params);
    if (request.method === "audit/retention-apply") return this.#applyAuditRetention(request.params);
    if (request.method === "support/plan") return this.#planSupportBundle(request.params);
    if (request.method === "support/apply") return this.#applySupportBundle(request.params);
    if (request.method === "circuit/reset") return this.#resetCircuit(request.params);
    if (request.method === "config/plan") return this.#plan(request.params);
    if (request.method === "config/apply") return this.#apply(request.params);
    if (request.method === "migrate/plan") return this.#planMigration(request.params);
    if (request.method === "migrate/apply") return this.#applyMigration(request.params);
    if (request.method === "archive/purge-plan") return this.#planArchivePurge(request.params);
    if (request.method === "archive/purge-apply") return this.#applyArchivePurge(request.params);
    if (request.method === "profile/purge-plan") return this.#planProfilePurge(request.params);
    if (request.method === "profile/purge-apply") return this.#applyProfilePurge(request.params);
    return this.#channelAction(request.method, request.params, emitEvent);
  }

  async #doctor(params: unknown): Promise<unknown> {
    if (params === undefined) return this.#operationsInspector.inspect();
    const record = asRecord(params);
    if (!record || Object.keys(record).some((key) => key !== "profileId")) {
      throw new AdministrationError("invalid_params", "doctor/run accepts only an optional profileId");
    }
    if (record.profileId === undefined) return this.#operationsInspector.inspect();
    if (typeof record.profileId !== "string" || record.profileId.length === 0) {
      throw new AdministrationError("invalid_params", "doctor/run profileId must be non-empty");
    }
    try {
      return await this.#operationsInspector.inspect([record.profileId]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("is not configured")) {
        throw new AdministrationError("profile_not_found", "Profile is not configured");
      }
      throw error;
    }
  }

  async #prepareBackup(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (
      !record ||
      typeof record.profileId !== "string" ||
      typeof record.manifestPath !== "string" ||
      typeof record.includeWorkspace !== "boolean"
    ) {
      throw new AdministrationError(
        "invalid_params",
        "backup/prepare requires profileId, manifestPath, and includeWorkspace"
      );
    }
    try {
      return await this.#backupCoordinator.prepare({
        profileId: record.profileId,
        manifestPath: record.manifestPath,
        includeWorkspace: record.includeWorkspace
      });
    } catch (error) {
      throw new AdministrationError(
        "backup_prepare_failed",
        error instanceof Error ? error.message : "Backup prepare failed"
      );
    }
  }

  async #finishBackup(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (
      !record ||
      typeof record.profileId !== "string" ||
      typeof record.manifestPath !== "string" ||
      typeof record.holdToken !== "string" ||
      record.snapshotConfirmed !== true
    ) {
      throw new AdministrationError(
        "invalid_params",
        "backup/finish requires profileId, manifestPath, holdToken, and snapshotConfirmed=true"
      );
    }
    try {
      return await this.#backupCoordinator.finish({
        profileId: record.profileId,
        manifestPath: record.manifestPath,
        holdToken: record.holdToken,
        snapshotConfirmed: true
      });
    } catch (error) {
      throw new AdministrationError(
        "backup_finish_failed",
        error instanceof Error ? error.message : "Backup finish failed"
      );
    }
  }

  async #validateRestore(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (!record || typeof record.profileId !== "string" || typeof record.manifestPath !== "string") {
      throw new AdministrationError(
        "invalid_params",
        "restore/validate requires profileId and manifestPath"
      );
    }
    try {
      return await this.#backupCoordinator.validateRestore({
        profileId: record.profileId,
        manifestPath: record.manifestPath
      });
    } catch (error) {
      throw new AdministrationError(
        "restore_validation_failed",
        error instanceof Error ? error.message : "Restore validation failed"
      );
    }
  }

  #queryAudit(params: unknown): unknown {
    const input = parseAuditSelection(params, false);
    try {
      return this.#auditManager.query(input);
    } catch (error) {
      throw new AdministrationError(
        "audit_query_failed",
        error instanceof Error ? error.message : "Audit query failed"
      );
    }
  }

  async #exportAudit(params: unknown): Promise<unknown> {
    const input = parseAuditSelection(params, true);
    try {
      return await this.#auditManager.export(input as typeof input & { destination: string });
    } catch (error) {
      throw new AdministrationError(
        "audit_export_failed",
        error instanceof Error ? error.message : "Audit export failed"
      );
    }
  }

  #planAuditRetention(params: unknown): unknown {
    const record = asRecord(params);
    if (
      !record ||
      typeof record.profileId !== "string" ||
      typeof record.beforeMs !== "number" ||
      !Number.isSafeInteger(record.beforeMs) ||
      record.beforeMs < 0
    ) throw new AdministrationError("invalid_params", "audit/retention-plan requires profileId and beforeMs");
    try {
      return this.#auditManager.planRetention(record.profileId, record.beforeMs);
    } catch (error) {
      throw new AdministrationError(
        "audit_retention_plan_failed",
        error instanceof Error ? error.message : "Audit retention planning failed"
      );
    }
  }

  #applyAuditRetention(params: unknown): unknown {
    const record = asRecord(params);
    if (
      !record ||
      typeof record.planToken !== "string" ||
      typeof record.confirmProfileId !== "string" ||
      typeof record.confirmRecordCount !== "number" ||
      !Number.isSafeInteger(record.confirmRecordCount) ||
      typeof record.confirmSelectionDigest !== "string"
    ) throw new AdministrationError("invalid_params", "Audit retention apply confirmation is incomplete");
    try {
      return this.#auditManager.applyRetention({
        planToken: record.planToken,
        confirmProfileId: record.confirmProfileId,
        confirmRecordCount: record.confirmRecordCount,
        confirmSelectionDigest: record.confirmSelectionDigest
      });
    } catch (error) {
      throw new AdministrationError(
        "audit_retention_apply_failed",
        error instanceof Error ? error.message : "Audit retention apply failed"
      );
    }
  }

  async #planSupportBundle(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (
      !record ||
      typeof record.fromMs !== "number" ||
      typeof record.toMs !== "number" ||
      typeof record.outputPath !== "string" ||
      (record.profileIds !== undefined && (
        !Array.isArray(record.profileIds) ||
        !record.profileIds.every((profileId) => typeof profileId === "string")
      ))
    ) throw new AdministrationError("invalid_params", "support/plan requires time range and outputPath");
    try {
      return await this.#supportBundleManager.plan({
        ...(record.profileIds === undefined ? {} : { profileIds: record.profileIds as string[] }),
        fromMs: record.fromMs,
        toMs: record.toMs,
        outputPath: record.outputPath
      });
    } catch (error) {
      throw new AdministrationError(
        "support_plan_failed",
        error instanceof Error ? error.message : "Support Bundle planning failed"
      );
    }
  }

  async #applySupportBundle(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (!record || typeof record.planToken !== "string" || typeof record.confirmPlanDigest !== "string") {
      throw new AdministrationError("invalid_params", "support/apply requires planToken and confirmPlanDigest");
    }
    try {
      return await this.#supportBundleManager.apply({
        planToken: record.planToken,
        confirmPlanDigest: record.confirmPlanDigest
      });
    } catch (error) {
      throw new AdministrationError(
        "support_apply_failed",
        error instanceof Error ? error.message : "Support Bundle creation failed"
      );
    }
  }

  async #resetCircuit(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (!record || typeof record.profileId !== "string") {
      throw new AdministrationError("invalid_params", "circuit/reset requires profileId");
    }
    try {
      return await this.#supervisor.executeCodexCircuitReset(record.profileId);
    } catch (error) {
      if (error instanceof ProfileRuntimeActionError) {
        throw new AdministrationError(error.code, error.message);
      }
      throw new AdministrationError(
        "circuit_reset_failed",
        error instanceof Error ? error.message : "Circuit reset failed"
      );
    }
  }

  async #planProfilePurge(params: unknown): Promise<ProfilePurgePlanResult> {
    const record = asRecord(params);
    if (!record || typeof record.profileId !== "string") {
      throw new AdministrationError("invalid_params", "profile/purge-plan requires profileId");
    }
    const configurationRevision = this.#supervisor.status().configurationRevision;
    const profile = this.#supervisor.profileConfiguration(record.profileId);
    if (!configurationRevision || !profile) {
      throw new AdministrationError("profile_not_found", "Profile is not configured");
    }
    if (profile.enabled) {
      throw new AdministrationError("profile_not_disabled", "Profile must be disabled before purge");
    }
    let preview: ProfilePurgePreview;
    try {
      preview = await planProfilePurge(profile);
    } catch (error) {
      throw new AdministrationError(
        "profile_purge_unavailable",
        error instanceof Error ? error.message : "Profile purge could not be planned"
      );
    }
    const result: ProfilePurgePlanResult = {
      ...preview,
      planToken: randomUUID(),
      configurationRevision,
      expiresAt: this.#now() + this.#planLifetimeMs
    };
    this.#profilePurgePlans.set(result.planToken, { result, preview });
    return result;
  }

  async #applyProfilePurge(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (!record || typeof record.planToken !== "string" || typeof record.confirmProfileId !== "string") {
      throw new AdministrationError(
        "invalid_params",
        "profile/purge-apply requires planToken and confirmProfileId"
      );
    }
    const pending = this.#profilePurgePlans.get(record.planToken);
    this.#profilePurgePlans.delete(record.planToken);
    if (!pending || pending.result.expiresAt < this.#now()) {
      throw new AdministrationError("plan_expired", "Profile purge plan is absent or expired");
    }
    if (pending.preview.profileId !== record.confirmProfileId) {
      throw new AdministrationError(
        "confirmation_mismatch",
        "Profile purge confirmation must match the complete Profile ID"
      );
    }
    if (this.#supervisor.status().configurationRevision !== pending.result.configurationRevision) {
      throw new AdministrationError("plan_stale", "Configuration Revision changed after planning");
    }
    try {
      return await this.#supervisor.maintainProfile(pending.preview.profileId, async (profile) => {
        if (profile.enabled) throw new Error("Profile must remain disabled");
        return applyProfilePurge({
          profile,
          expectedSelectionDigest: pending.preview.selectionDigest,
          confirmedProfileId: record.confirmProfileId as string,
          nowMs: this.#now()
        });
      });
    } catch (error) {
      throw new AdministrationError(
        "profile_purge_failed",
        error instanceof Error ? error.message : "Profile purge failed"
      );
    }
  }

  async #planArchivePurge(params: unknown): Promise<ArchivePurgePlanResult> {
    const record = asRecord(params);
    if (!record || typeof record.profileId !== "string") {
      throw new AdministrationError("invalid_params", "archive/purge-plan requires profileId");
    }
    const configurationRevision = this.#supervisor.status().configurationRevision;
    const profile = this.#supervisor.profileConfiguration(record.profileId);
    if (!configurationRevision || !profile) {
      throw new AdministrationError("profile_not_found", "Profile is not configured");
    }
    const scope = parseArchivePurgeScope(record);
    const store = await ProfileStore.open({
      profileId: profile.id,
      databasePath: join(profile.stateDirectory, "bridge.sqlite")
    });
    let preview: ArchivePurgePreview;
    try {
      preview = await store.previewArchivePurge(scope);
    } finally {
      await store.close();
    }
    const result: ArchivePurgePlanResult = {
      ...preview,
      planToken: randomUUID(),
      configurationRevision,
      expiresAt: this.#now() + this.#planLifetimeMs
    };
    this.#archivePurgePlans.set(result.planToken, { result, preview });
    return result;
  }

  async #applyArchivePurge(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    if (
      !record ||
      typeof record.planToken !== "string" ||
      typeof record.confirmProfileId !== "string" ||
      typeof record.confirmMessageCount !== "number" ||
      !Number.isSafeInteger(record.confirmMessageCount)
    ) {
      throw new AdministrationError(
        "invalid_params",
        "archive/purge-apply requires planToken, confirmProfileId, and confirmMessageCount"
      );
    }
    const pending = this.#archivePurgePlans.get(record.planToken);
    this.#archivePurgePlans.delete(record.planToken);
    if (!pending || pending.result.expiresAt < this.#now()) {
      throw new AdministrationError("plan_expired", "Archive purge plan is absent or expired");
    }
    if (
      pending.preview.profileId !== record.confirmProfileId ||
      pending.preview.messageCount !== record.confirmMessageCount
    ) {
      throw new AdministrationError(
        "confirmation_mismatch",
        "Archive purge confirmation must match the complete Profile ID and expected count"
      );
    }
    if (this.#supervisor.status().configurationRevision !== pending.result.configurationRevision) {
      throw new AdministrationError("plan_stale", "Configuration Revision changed after planning");
    }
    try {
      return await this.#supervisor.maintainProfile(pending.preview.profileId, async (profile) => {
        const store = await ProfileStore.open({
          profileId: profile.id,
          databasePath: join(profile.stateDirectory, "bridge.sqlite")
        });
        try {
          const current = await store.previewArchivePurge(pending.preview.scope);
          if (
            current.selectionDigest !== pending.preview.selectionDigest ||
            current.messageCount !== pending.preview.messageCount
          ) {
            throw new AdministrationError("plan_stale", "Archive purge selection changed after planning");
          }
          const result = await store.applyArchivePurge({
            scope: pending.preview.scope,
            expectedMessageCount: pending.preview.messageCount,
            expectedSelectionDigest: pending.preview.selectionDigest,
            confirmedProfileId: record.confirmProfileId as string,
            atMs: this.#now()
          });
          let mediaCleanupFailures = 0;
          for (const digest of result.unreferencedContentSha256) {
            if (!/^[a-f0-9]{64}$/.test(digest)) {
              mediaCleanupFailures += 1;
              continue;
            }
            await unlink(join(profile.stateDirectory, "media", "sha256", digest.slice(0, 2), digest))
              .catch((error: unknown) => {
                if (!isMissingPath(error)) mediaCleanupFailures += 1;
              });
          }
          return { ...result, mediaCleanupFailures };
        } finally {
          await store.close();
        }
      });
    } catch (error) {
      if (error instanceof AdministrationError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (message.includes("stopped")) {
        throw new AdministrationError("profile_not_quiescent", "Profile must be disabled and stopped");
      }
      throw error;
    }
  }

  async #channelAction(
    method: Extract<
      AdministrationRequest["method"],
      "channel/connect" | "channel/disconnect" | "whatsapp/pair" | "whatsapp/logout" | "whatsapp/forget-local"
    >,
    params: unknown,
    emitEvent: (event: WhatsAppChannelAccountEvent) => Promise<void>
  ): Promise<unknown> {
    const record = asRecord(params);
    if (!record || typeof record.profileId !== "string" || typeof record.channelAccountId !== "string") {
      throw new AdministrationError("invalid_params", `${method} requires profileId and channelAccountId`);
    }
    let action;
    if (method === "channel/connect") action = { kind: "connect" } as const;
    else if (method === "channel/disconnect") action = { kind: "disconnect" } as const;
    else if (method === "whatsapp/logout") action = { kind: "logout" } as const;
    else if (method === "whatsapp/pair") {
      if (record.timeoutMs !== undefined && (
        typeof record.timeoutMs !== "number" ||
        !Number.isInteger(record.timeoutMs) ||
        record.timeoutMs < 1_000 ||
        record.timeoutMs > 300_000
      )) {
        throw new AdministrationError("invalid_params", "whatsapp/pair timeoutMs must be 1000..300000");
      }
      action = {
        kind: "pair" as const,
        ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs })
      };
    } else {
      if (typeof record.confirmChannelAccountId !== "string") {
        throw new AdministrationError(
          "invalid_params",
          "whatsapp/forget-local requires confirmChannelAccountId"
        );
      }
      action = {
        kind: "forget_local" as const,
        confirmChannelAccountId: record.confirmChannelAccountId
      };
    }
    try {
      return await this.#supervisor.executeWhatsAppAccountAction(
        record.profileId,
        record.channelAccountId,
        action,
        emitEvent
      );
    } catch (error) {
      if (error instanceof ProfileRuntimeActionError) {
        throw new AdministrationError(error.code, error.message);
      }
      const message = error instanceof Error ? error.message : "";
      if (message.includes("not enabled") || message.includes("unavailable")) {
        throw new AdministrationError("profile_unavailable", "Profile worker is unavailable");
      }
      throw error;
    }
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
    for (const [token, plan] of this.#archivePurgePlans) {
      if (plan.result.expiresAt < now) this.#archivePurgePlans.delete(token);
    }
    for (const [token, plan] of this.#profilePurgePlans) {
      if (plan.result.expiresAt < now) this.#profilePurgePlans.delete(token);
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

function parseArchivePurgeScope(record: Record<string, unknown>): ArchivePurgeScope {
  if (record.scope === "profile") {
    if (record.conversationKey !== undefined || record.beforeMs !== undefined) {
      throw new AdministrationError("invalid_params", "Profile Archive purge accepts no conversation range");
    }
    return { kind: "profile" };
  }
  if (
    record.scope === "conversation_before" &&
    typeof record.conversationKey === "string" &&
    typeof record.beforeMs === "number" &&
    Number.isSafeInteger(record.beforeMs) &&
    record.beforeMs >= 0
  ) {
    return {
      kind: "conversation_before",
      conversationKey: record.conversationKey,
      beforeMs: record.beforeMs
    };
  }
  throw new AdministrationError(
    "invalid_params",
    "Archive purge scope must be profile or exact conversation_before"
  );
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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

function parseAuditSelection(params: unknown, requireDestination: boolean): {
  readonly profileId?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly limit?: number;
  readonly destination?: string;
} {
  const record = asRecord(params);
  if (!record) throw new AdministrationError("invalid_params", "Audit selection must be an object");
  if (record.profileId !== undefined && typeof record.profileId !== "string") {
    throw new AdministrationError("invalid_params", "Audit profileId must be a string");
  }
  for (const key of ["fromMs", "toMs", "limit"] as const) {
    const value = record[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
      throw new AdministrationError("invalid_params", `Audit ${key} must be a nonnegative integer`);
    }
  }
  if (requireDestination && typeof record.destination !== "string") {
    throw new AdministrationError("invalid_params", "Audit export requires destination");
  }
  return {
    ...(record.profileId === undefined ? {} : { profileId: record.profileId }),
    ...(record.fromMs === undefined ? {} : { fromMs: record.fromMs as number }),
    ...(record.toMs === undefined ? {} : { toMs: record.toMs as number }),
    ...(record.limit === undefined ? {} : { limit: record.limit as number }),
    ...(record.destination === undefined ? {} : { destination: record.destination as string })
  };
}
