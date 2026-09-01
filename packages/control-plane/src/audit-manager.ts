import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  SqliteProfileStore,
  type AuditRecord,
  type AuditRetentionPreview,
  type AuditRetentionResult
} from "@codex-channel-bridge/profile-store";
import type { Supervisor } from "@codex-channel-bridge/supervisor";

import { writeOwnerOnlyExclusiveFile } from "./owner-only-output.js";

export interface ProfileAuditRecord extends AuditRecord {
  readonly profileId: string;
}

export interface AuditRetentionPlan extends AuditRetentionPreview {
  readonly planToken: string;
  readonly configurationRevision: string;
  readonly expiresAtMs: number;
}

interface PendingRetention {
  readonly plan: AuditRetentionPlan;
}

/** Host-local Audit query, export, and explicit retention workflow. */
export class AuditManager {
  readonly #supervisor: Supervisor;
  readonly #now: () => number;
  readonly #planLifetimeMs: number;
  readonly #retentionPlans = new Map<string, PendingRetention>();

  public constructor(
    supervisor: Supervisor,
    now: () => number = Date.now,
    planLifetimeMs = 5 * 60_000
  ) {
    this.#supervisor = supervisor;
    this.#now = now;
    this.#planLifetimeMs = planLifetimeMs;
  }

  public query(input: {
    readonly profileId?: string;
    readonly fromMs?: number;
    readonly toMs?: number;
    readonly limit?: number;
  } = {}): readonly ProfileAuditRecord[] {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Audit limit must be 1..500");
    const profileIds = this.#profileIds(input.profileId);
    const records = profileIds.flatMap((profileId) => {
      const profile = this.#supervisor.profileConfiguration(profileId)!;
      const store = SqliteProfileStore.open({
        profileId,
        databasePath: join(profile.stateDirectory, "bridge.sqlite"),
        readOnly: true
      });
      try {
        return store.queryAuditRecords({
          ...(input.fromMs === undefined ? {} : { fromMs: input.fromMs }),
          ...(input.toMs === undefined ? {} : { toMs: input.toMs }),
          limit
        }).map((record) => ({ profileId, ...record }));
      } finally {
        store.close();
      }
    });
    return records
      .sort((left, right) => right.atMs - left.atMs || right.auditRecordId.localeCompare(left.auditRecordId))
      .slice(0, limit);
  }

  public async export(input: {
    readonly destination: string;
    readonly profileId?: string;
    readonly fromMs?: number;
    readonly toMs?: number;
    readonly limit?: number;
  }): Promise<{ readonly recordCount: number; readonly destination: string }> {
    const records = this.query(input);
    await writeOwnerOnlyExclusiveFile(input.destination, `${JSON.stringify({
      schemaVersion: 1,
      kind: "codex-channel-bridge-audit-export",
      exportedAtMs: this.#now(),
      records
    }, null, 2)}\n`);
    return { recordCount: records.length, destination: input.destination };
  }

  public planRetention(profileId: string, beforeMs: number): AuditRetentionPlan {
    this.#expire();
    const revision = this.#supervisor.status().configurationRevision;
    const profile = this.#supervisor.profileConfiguration(profileId);
    if (!revision || !profile) throw new Error("Profile is not configured");
    const store = SqliteProfileStore.open({
      profileId,
      databasePath: join(profile.stateDirectory, "bridge.sqlite"),
      readOnly: true
    });
    let preview: AuditRetentionPreview;
    try {
      preview = store.previewAuditRetention(beforeMs);
    } finally {
      store.close();
    }
    const plan: AuditRetentionPlan = {
      ...preview,
      planToken: randomUUID(),
      configurationRevision: revision,
      expiresAtMs: this.#now() + this.#planLifetimeMs
    };
    this.#retentionPlans.set(plan.planToken, { plan });
    return plan;
  }

  public applyRetention(input: {
    readonly planToken: string;
    readonly confirmProfileId: string;
    readonly confirmRecordCount: number;
    readonly confirmSelectionDigest: string;
  }): AuditRetentionResult {
    this.#expire();
    const pending = this.#retentionPlans.get(input.planToken);
    this.#retentionPlans.delete(input.planToken);
    if (!pending) throw new Error("Audit retention plan is absent or expired");
    const plan = pending.plan;
    if (
      input.confirmProfileId !== plan.profileId ||
      input.confirmRecordCount !== plan.recordCount ||
      input.confirmSelectionDigest !== plan.selectionDigest
    ) throw new Error("Audit retention confirmation does not match the plan");
    if (this.#supervisor.status().configurationRevision !== plan.configurationRevision) {
      throw new Error("Configuration Revision changed after Audit retention planning");
    }
    const profile = this.#supervisor.profileConfiguration(plan.profileId);
    if (!profile) throw new Error("Profile is not configured");
    const store = SqliteProfileStore.open({
      profileId: plan.profileId,
      databasePath: join(profile.stateDirectory, "bridge.sqlite")
    });
    try {
      return store.applyAuditRetention({
        beforeMs: plan.beforeMs,
        expectedRecordCount: plan.recordCount,
        expectedSelectionDigest: plan.selectionDigest,
        correlationId: input.planToken,
        atMs: this.#now()
      });
    } finally {
      store.close();
    }
  }

  #profileIds(profileId?: string): readonly string[] {
    if (profileId !== undefined) {
      if (!this.#supervisor.profileConfiguration(profileId)) throw new Error("Profile is not configured");
      return [profileId];
    }
    return this.#supervisor.status().profiles.map((profile) => profile.profileId).sort();
  }

  #expire(): void {
    const now = this.#now();
    for (const [token, pending] of this.#retentionPlans) {
      if (pending.plan.expiresAtMs < now) this.#retentionPlans.delete(token);
    }
  }
}
