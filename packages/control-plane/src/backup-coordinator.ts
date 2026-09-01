import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  SqliteProfileStore,
  checkpointProfileStore,
  inspectProfileStore,
  type OutboxCounts,
  type ProfileStoreCheckpoint
} from "@codex-channel-bridge/profile-store";
import type { Supervisor } from "@codex-channel-bridge/supervisor";
import { writeOwnerOnlyExclusiveFile } from "./owner-only-output.js";

const MAX_MANIFEST_BYTES = 128 * 1024;

export interface ProfileBackupManifest {
  readonly schemaVersion: 1;
  readonly kind: "codex-channel-bridge-profile-backup";
  readonly profileId: string;
  readonly configurationRevision: string;
  readonly operatingSystem: NodeJS.Platform;
  readonly preparedAtMs: number;
  readonly holdToken: string;
  readonly codexVersion: string | null;
  readonly codexVerification: "tested" | "unverified" | null;
  readonly bridgeSchemaVersion: number;
  readonly outbox: OutboxCounts;
  readonly checkpoint: ProfileStoreCheckpoint;
  readonly snapshotPaths: {
    readonly stateDirectory: string;
    readonly codexHome: string;
    readonly workspace: string | null;
    readonly externalSecretsFile: string | null;
  };
  readonly manifestDigest: string;
}

export interface BackupPrepareResult {
  readonly profileId: string;
  readonly holdToken: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly snapshotRequired: true;
}

export interface RestoreValidationResult {
  readonly profileId: string;
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly manifestDigest: string;
}

/** Coordinates stopped Profile snapshots while leaving all byte copying to the operator. */
export class BackupCoordinator {
  readonly #supervisor: Supervisor;
  readonly #now: () => number;

  public constructor(supervisor: Supervisor, now: () => number = Date.now) {
    this.#supervisor = supervisor;
    this.#now = now;
  }

  public async prepare(input: {
    readonly profileId: string;
    readonly manifestPath: string;
    readonly includeWorkspace: boolean;
  }): Promise<BackupPrepareResult> {
    requireAbsoluteManifestPath(input.manifestPath);
    const revision = this.#supervisor.status().configurationRevision;
    const profile = this.#supervisor.profileConfiguration(input.profileId);
    if (!revision || !profile) throw new Error("Profile is not configured");
    const before = this.#supervisor.status().profiles.find((value) => value.profileId === input.profileId);
    const hold = await this.#supervisor.holdProfile(input.profileId, "backup");
    try {
      if (!hold.drainCompleted) throw new Error("Profile did not complete its bounded drain");
      const databasePath = join(profile.stateDirectory, "bridge.sqlite");
      const store = SqliteProfileStore.open({ profileId: profile.id, databasePath });
      let outbox: OutboxCounts;
      try {
        outbox = store.outboxCounts();
        if (outbox.pending + outbox.leased + outbox.retryWait !== 0) {
          throw new Error("Profile outbox is not fully flushed");
        }
        store.appendAuditRecord({
          correlationId: hold.token,
          action: "backup_prepare",
          result: "succeeded",
          targetReference: hold.token,
          atMs: this.#now()
        });
      } finally {
        store.close();
      }
      const checkpoint = await checkpointProfileStore({ profileId: profile.id, databasePath });
      const inspection = await inspectProfileStore({ profileId: profile.id, databasePath });
      const manifestBase = {
        schemaVersion: 1 as const,
        kind: "codex-channel-bridge-profile-backup" as const,
        profileId: profile.id,
        configurationRevision: revision,
        operatingSystem: process.platform,
        preparedAtMs: this.#now(),
        holdToken: hold.token,
        codexVersion: before?.codexVersion ?? null,
        codexVerification: before?.codexVerification ?? null,
        bridgeSchemaVersion: inspection.schemaVersion,
        outbox,
        checkpoint,
        snapshotPaths: {
          stateDirectory: profile.stateDirectory,
          codexHome: profile.codexHome,
          workspace: input.includeWorkspace ? profile.workspace : null,
          externalSecretsFile: isWithin(profile.stateDirectory, profile.secretsFile)
            ? null
            : profile.secretsFile
        }
      };
      const manifest: ProfileBackupManifest = {
        ...manifestBase,
        manifestDigest: digest(manifestBase)
      };
      await writeOwnerOnlyExclusiveFile(input.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return {
        profileId: profile.id,
        holdToken: hold.token,
        manifestPath: input.manifestPath,
        manifestDigest: manifest.manifestDigest,
        snapshotRequired: true
      };
    } catch (error) {
      await this.#supervisor.releaseProfileHold(input.profileId, hold.token).catch(() => undefined);
      throw error;
    }
  }

  public async finish(input: {
    readonly profileId: string;
    readonly manifestPath: string;
    readonly holdToken: string;
    readonly snapshotConfirmed: true;
  }): Promise<{ readonly profileId: string; readonly resumed: boolean }> {
    const manifest = await readBackupManifest(input.manifestPath);
    if (
      manifest.profileId !== input.profileId ||
      manifest.holdToken !== input.holdToken ||
      input.snapshotConfirmed !== true
    ) throw new Error("Backup finish confirmation does not match the prepared Profile");
    const profile = this.#supervisor.profileConfiguration(input.profileId);
    if (!profile) throw new Error("Profile is not configured");
    const store = SqliteProfileStore.open({
      profileId: profile.id,
      databasePath: join(profile.stateDirectory, "bridge.sqlite")
    });
    try {
      store.appendAuditRecord({
        correlationId: input.holdToken,
        action: "backup_finish",
        result: "succeeded",
        targetReference: manifest.manifestDigest,
        atMs: this.#now()
      });
    } finally {
      store.close();
    }
    const health = await this.#supervisor.releaseProfileHold(input.profileId, input.holdToken);
    return { profileId: input.profileId, resumed: health.readiness !== "stopped" };
  }

  public async validateRestore(input: {
    readonly profileId: string;
    readonly manifestPath: string;
  }): Promise<RestoreValidationResult> {
    const manifest = await readBackupManifest(input.manifestPath);
    const profile = this.#supervisor.profileConfiguration(input.profileId);
    if (!profile) throw new Error("Profile is not configured");
    const hold = await this.#supervisor.profileHold(input.profileId);
    const issues: string[] = [];
    if (manifest.profileId !== input.profileId) issues.push("profile_id_mismatch");
    if (manifest.operatingSystem !== process.platform) issues.push("operating_system_mismatch");
    if (manifest.snapshotPaths.stateDirectory !== profile.stateDirectory) issues.push("state_path_mismatch");
    if (manifest.snapshotPaths.codexHome !== profile.codexHome) issues.push("codex_home_path_mismatch");
    if (manifest.snapshotPaths.workspace !== null && manifest.snapshotPaths.workspace !== profile.workspace) {
      issues.push("workspace_path_mismatch");
    }
    if (!hold || hold.token !== manifest.holdToken) issues.push("maintenance_hold_missing");
    try {
      const inspection = await inspectProfileStore({
        profileId: profile.id,
        databasePath: join(profile.stateDirectory, "bridge.sqlite")
      });
      if (inspection.quickCheck !== "ok") issues.push("sqlite_quick_check_failed");
      if (inspection.schemaVersion !== manifest.bridgeSchemaVersion) issues.push("bridge_schema_mismatch");
      if (inspection.profileMatches !== true) issues.push("profile_store_mismatch");
      const store = SqliteProfileStore.open({
        profileId: profile.id,
        databasePath: join(profile.stateDirectory, "bridge.sqlite"),
        readOnly: true
      });
      try {
        const outbox = store.outboxCounts();
        if (outbox.pending + outbox.leased + outbox.retryWait !== 0) issues.push("outbox_not_quiescent");
      } finally {
        store.close();
      }
    } catch {
      issues.push("profile_store_unavailable");
    }
    return {
      profileId: input.profileId,
      valid: issues.length === 0,
      issues: [...new Set(issues)].sort(),
      manifestDigest: manifest.manifestDigest
    };
  }
}

export async function readBackupManifest(path: string): Promise<ProfileBackupManifest> {
  requireAbsoluteManifestPath(path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MANIFEST_BYTES) {
    throw new Error("Backup manifest must be a bounded regular file");
  }
  if (
    process.platform !== "win32" &&
    (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600)
  ) throw new Error("Backup manifest must be owner-only");
  const parsed = JSON.parse(await readFile(path, "utf8")) as ProfileBackupManifest;
  const { manifestDigest, ...base } = parsed;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.kind !== "codex-channel-bridge-profile-backup" ||
    typeof manifestDigest !== "string" ||
    manifestDigest !== digest(base)
  ) throw new Error("Backup manifest is invalid or changed");
  return parsed;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireAbsoluteManifestPath(path: string): void {
  if (!isAbsolute(path)) throw new Error("Backup manifest path must be absolute");
}

function isWithin(parent: string, child: string): boolean {
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(prefix);
}
