import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { rmdir, unlink } from "node:fs/promises";

import { SqliteProfileStore } from "@codex-channel-bridge/profile-store";
import type { Supervisor } from "@codex-channel-bridge/supervisor";

import { AuditManager } from "./audit-manager.js";
import { OperationsInspector } from "./operations-inspector.js";
import { createOwnerOnlyDirectory, writeOwnerOnlyFile } from "./owner-only-output.js";

const ALLOWLISTED_FIELDS = [
  "bridge/platform version",
  "configuration and schema revision",
  "capability verification state",
  "Profile health and reason codes",
  "path permission shape without paths",
  "SQLite integrity and table counts",
  "disk available bytes",
  "Audit action/result counts"
] as const;

export interface SupportBundlePlan {
  readonly planToken: string;
  readonly planDigest: string;
  readonly configurationRevision: string;
  readonly profileIds: readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly outputPath: string;
  readonly allowlistedFields: typeof ALLOWLISTED_FIELDS;
  readonly estimatedBytes: number;
  readonly expiresAtMs: number;
}

interface PendingBundlePlan {
  readonly plan: SupportBundlePlan;
}

/** Creates a local, content-free diagnostics directory after an explicit plan. */
export class SupportBundleManager {
  readonly #supervisor: Supervisor;
  readonly #inspector: OperationsInspector;
  readonly #audits: AuditManager;
  readonly #now: () => number;
  readonly #planLifetimeMs: number;
  readonly #plans = new Map<string, PendingBundlePlan>();

  public constructor(
    supervisor: Supervisor,
    inspector: OperationsInspector,
    audits: AuditManager,
    now: () => number = Date.now,
    planLifetimeMs = 5 * 60_000
  ) {
    this.#supervisor = supervisor;
    this.#inspector = inspector;
    this.#audits = audits;
    this.#now = now;
    this.#planLifetimeMs = planLifetimeMs;
  }

  public async plan(input: {
    readonly profileIds?: readonly string[];
    readonly fromMs: number;
    readonly toMs: number;
    readonly outputPath: string;
  }): Promise<SupportBundlePlan> {
    this.#expire();
    validateRange(input.fromMs, input.toMs);
    const revision = this.#supervisor.status().configurationRevision;
    if (!revision) throw new Error("Supervisor has no accepted Configuration Revision");
    const profileIds = input.profileIds === undefined
      ? this.#supervisor.status().profiles.map((profile) => profile.profileId).sort()
      : [...new Set(input.profileIds)].sort();
    if (profileIds.length === 0) throw new Error("Support Bundle requires at least one Profile");
    await this.#inspector.inspect(profileIds);
    const planBase = {
      configurationRevision: revision,
      profileIds,
      fromMs: input.fromMs,
      toMs: input.toMs,
      outputPath: input.outputPath,
      allowlistedFields: ALLOWLISTED_FIELDS,
      estimatedBytes: 32_768 + profileIds.length * 16_384
    };
    const plan: SupportBundlePlan = {
      planToken: randomUUID(),
      planDigest: sha256(JSON.stringify(planBase)),
      ...planBase,
      expiresAtMs: this.#now() + this.#planLifetimeMs
    };
    this.#plans.set(plan.planToken, { plan });
    return plan;
  }

  public async apply(input: {
    readonly planToken: string;
    readonly confirmPlanDigest: string;
  }): Promise<{
    readonly outputPath: string;
    readonly profileIds: readonly string[];
    readonly fileCount: number;
    readonly manifestDigest: string;
  }> {
    this.#expire();
    const pending = this.#plans.get(input.planToken);
    this.#plans.delete(input.planToken);
    if (!pending) throw new Error("Support Bundle plan is absent or expired");
    const plan = pending.plan;
    if (input.confirmPlanDigest !== plan.planDigest) throw new Error("Support Bundle plan digest did not match");
    if (this.#supervisor.status().configurationRevision !== plan.configurationRevision) {
      throw new Error("Configuration Revision changed after Support Bundle planning");
    }
    const inspection = await this.#inspector.inspect(plan.profileIds);
    const summaries = plan.profileIds.map((profileId) => {
      const records = this.#audits.query({
        profileId,
        fromMs: plan.fromMs,
        toMs: plan.toMs,
        limit: 500
      });
      const counts = new Map<string, number>();
      for (const record of records) {
        const key = `${record.action}\u0000${record.result}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return {
        profileId,
        sampledRecordCount: records.length,
        sampleLimit: 500,
        actionResults: [...counts].sort().map(([key, count]) => {
          const [action, result] = key.split("\u0000");
          return { action, result, count };
        })
      };
    });
    const metadata = `${JSON.stringify({
      schemaVersion: 1,
      kind: "codex-channel-bridge-support-bundle-metadata",
      createdAtMs: this.#now(),
      bridgeVersion: "0.1.0-dev",
      operatingSystem: process.platform,
      timeRange: { fromMs: plan.fromMs, toMs: plan.toMs },
      inspection
    }, null, 2)}\n`;
    const auditSummary = `${JSON.stringify({
      schemaVersion: 1,
      kind: "codex-channel-bridge-audit-summary",
      timeRange: { fromMs: plan.fromMs, toMs: plan.toMs },
      profiles: summaries
    }, null, 2)}\n`;
    const files = [
      { name: "metadata.json", contents: metadata },
      { name: "audit-summary.json", contents: auditSummary }
    ];
    const manifestBase = {
      schemaVersion: 1,
      kind: "codex-channel-bridge-support-bundle-manifest",
      files: files.map((file) => ({
        name: file.name,
        bytes: Buffer.byteLength(file.contents),
        sha256: sha256(file.contents)
      }))
    };
    const manifest = `${JSON.stringify({
      ...manifestBase,
      manifestDigest: sha256(JSON.stringify(manifestBase))
    }, null, 2)}\n`;
    const created: string[] = [];
    await createOwnerOnlyDirectory(plan.outputPath);
    try {
      for (const file of files) {
        const path = join(plan.outputPath, file.name);
        await writeOwnerOnlyFile(path, file.contents);
        created.push(path);
      }
      const manifestPath = join(plan.outputPath, "manifest.json");
      await writeOwnerOnlyFile(manifestPath, manifest);
      created.push(manifestPath);
      for (const profileId of plan.profileIds) {
        const profile = this.#supervisor.profileConfiguration(profileId)!;
        const store = SqliteProfileStore.open({
          profileId,
          databasePath: join(profile.stateDirectory, "bridge.sqlite")
        });
        try {
          store.appendAuditRecord({
            correlationId: plan.planToken,
            action: "support_bundle_create",
            result: "succeeded",
            targetReference: plan.planDigest,
            atMs: this.#now()
          });
        } finally {
          store.close();
        }
      }
      return {
        outputPath: plan.outputPath,
        profileIds: plan.profileIds,
        fileCount: created.length,
        manifestDigest: sha256(JSON.stringify(manifestBase))
      };
    } catch (error) {
      for (const path of created.reverse()) await unlink(path).catch(() => undefined);
      await rmdir(plan.outputPath).catch(() => undefined);
      throw error;
    }
  }

  #expire(): void {
    const now = this.#now();
    for (const [token, pending] of this.#plans) {
      if (pending.plan.expiresAtMs < now) this.#plans.delete(token);
    }
  }
}

function validateRange(fromMs: number, toMs: number): void {
  if (
    !Number.isSafeInteger(fromMs) ||
    !Number.isSafeInteger(toMs) ||
    fromMs < 0 ||
    toMs < fromMs
  ) throw new Error("Support Bundle time range is invalid");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
