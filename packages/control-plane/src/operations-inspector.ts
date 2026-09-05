import { lstat, statfs } from "node:fs/promises";
import { join } from "node:path";

import type { ProfileConfiguration } from "@codex-channel-bridge/config";
import type { ProfileHealth } from "@codex-channel-bridge/core";
import {
  inspectProfileStore,
  type ProfileStoreInspection
} from "@codex-channel-bridge/profile-store";
import { assertWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";
import type { SupervisorStatus } from "@codex-channel-bridge/supervisor";

export interface OperationsInspectionSource {
  status(): SupervisorStatus;
  profileConfiguration(profileId: string): Readonly<ProfileConfiguration> | undefined;
}

export interface PathInspection {
  readonly exists: boolean;
  readonly kind: "directory" | "file" | "other" | "missing";
  readonly symlink: boolean;
  readonly ownerOnly: boolean | null;
}

export interface ProfileOperationsInspection {
  readonly profileId: string;
  readonly enabled: boolean;
  readonly health: ProfileHealth;
  readonly paths: {
    readonly workspace: PathInspection;
    readonly codexHome: PathInspection;
    readonly stateDirectory: PathInspection;
  };
  readonly disk: {
    readonly availableBytes: number;
  } | null;
  readonly store: ProfileStoreInspection | null;
  readonly issues: readonly string[];
  readonly configurationShape: {
    readonly channelAccounts: Readonly<Record<string, { readonly provider: string; readonly enabled: boolean }>>;
    readonly admissionMode: string;
    readonly approvalDetail: string;
    readonly mediaLimits: {
      readonly perAttachmentLimitBytes: number;
      readonly profileQuotaBytes: number;
    };
  };
}

export interface OperationsInspection {
  readonly inspectedAtMs: number;
  readonly liveness: SupervisorStatus["liveness"];
  readonly configurationRevision: string | null;
  readonly ok: boolean;
  readonly profiles: readonly ProfileOperationsInspection[];
}

/** Deep read-only operations module shared by Doctor and Support Bundle creation. */
export class OperationsInspector {
  readonly #source: OperationsInspectionSource;
  readonly #now: () => number;

  public constructor(source: OperationsInspectionSource, now: () => number = Date.now) {
    this.#source = source;
    this.#now = now;
  }

  public async inspect(profileIds?: readonly string[]): Promise<OperationsInspection> {
    const status = this.#source.status();
    const healthById = new Map(status.profiles.map((profile) => [profile.profileId, profile]));
    const ids = profileIds === undefined
      ? [...healthById.keys()].sort()
      : [...new Set(profileIds)].sort();
    const profiles = await Promise.all(ids.map(async (profileId) => {
      const profile = this.#source.profileConfiguration(profileId);
      if (!profile) throw new Error(`Profile ${profileId} is not configured`);
      const health = healthById.get(profileId) ?? {
        profileId,
        readiness: "stopped" as const,
        reason: null
      };
      return inspectProfile(profile, health);
    }));
    return {
      inspectedAtMs: this.#now(),
      liveness: status.liveness,
      configurationRevision: status.configurationRevision,
      ok: status.liveness === "live" && profiles.every((profile) => profile.issues.length === 0),
      profiles
    };
  }
}

async function inspectProfile(
  profile: Readonly<ProfileConfiguration>,
  health: ProfileHealth
): Promise<ProfileOperationsInspection> {
  const [workspace, codexHome, stateDirectory] = await Promise.all([
    inspectPath(profile.workspace),
    inspectPath(profile.codexHome),
    inspectPath(profile.stateDirectory, true)
  ]);
  const issues: string[] = [];
  if (workspace.kind !== "directory" || workspace.symlink) issues.push("workspace_invalid");
  if (codexHome.kind !== "directory" || codexHome.symlink) issues.push("codex_home_invalid");
  if (stateDirectory.kind !== "directory" || stateDirectory.symlink || stateDirectory.ownerOnly === false) {
    issues.push("state_directory_insecure");
  }
  let disk: ProfileOperationsInspection["disk"] = null;
  try {
    const value = await statfs(profile.stateDirectory);
    disk = { availableBytes: safeBytes(value.bavail, value.bsize) };
  } catch {
    issues.push("disk_capacity_unavailable");
  }
  let store: ProfileStoreInspection | null = null;
  try {
    store = await inspectProfileStore({
      profileId: profile.id,
      databasePath: join(profile.stateDirectory, "bridge.sqlite")
    });
    if (store.quickCheck !== "ok") issues.push("sqlite_quick_check_failed");
    if (store.profileMatches !== true) issues.push("profile_store_mismatch");
    if (store.migrationRequired) issues.push("migration_required");
  } catch {
    issues.push("profile_store_unavailable");
  }
  if (profile.enabled && health.readiness !== "ready" && health.readiness !== "degraded") {
    issues.push(health.reason ?? "profile_not_ready");
  }
  return {
    profileId: profile.id,
    enabled: profile.enabled,
    health,
    paths: { workspace, codexHome, stateDirectory },
    disk,
    store,
    issues: [...new Set(issues)].sort(),
    configurationShape: {
      channelAccounts: Object.fromEntries(Object.entries(profile.channelAccounts).map(([id, account]) => [
        id,
        { provider: account.provider, enabled: account.enabled }
      ])),
      admissionMode: profile.admission.mode,
      approvalDetail: profile.approval.detail,
      mediaLimits: profile.media
    }
  };
}

async function inspectPath(path: string, verifyWindowsAcl = false): Promise<PathInspection> {
  try {
    const value = await lstat(path);
    const kind = value.isDirectory() ? "directory" as const : value.isFile() ? "file" as const : "other" as const;
    return {
      exists: true,
      kind,
      symlink: value.isSymbolicLink(),
      ownerOnly: process.platform === "win32"
        ? verifyWindowsAcl ? windowsOwnerOnly(path, kind) : null
        : value.uid === process.getuid?.() && (value.mode & 0o077) === 0
    };
  } catch (error) {
    if (isMissing(error)) return { exists: false, kind: "missing", symlink: false, ownerOnly: null };
    throw error;
  }
}

function windowsOwnerOnly(path: string, kind: "file" | "directory" | "other"): boolean {
  if (kind === "other") return false;
  try {
    assertWindowsOwnerOnlyPath(path, kind);
    return true;
  } catch {
    return false;
  }
}

function safeBytes(blocks: number, blockSize: number): number {
  const value = blocks * blockSize;
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
