import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type {
  ConfigurationCandidate,
  ProfileConfiguration
} from "@codex-channel-bridge/config";
import { BRIDGE_VERSION, type ProfileHealth } from "@codex-channel-bridge/core";
import type {
  CodexCircuitResetResult,
  WhatsAppChannelAccountAction,
  WhatsAppChannelAccountEvent,
  WhatsAppChannelAccountResult
} from "@codex-channel-bridge/profile-worker";

import {
  ForkedProfileRuntimeFactory,
  type ProfileRuntime,
  type ProfileRuntimeFactory
} from "./profile-runtime.js";

export type SupervisorLiveness = "starting" | "live" | "stopping" | "stopped";
export type ProfileApplyAction = "start" | "stop" | "restart" | "unchanged";

export interface ConfigurationApplyEntry {
  readonly profileId: string;
  readonly action: ProfileApplyAction;
}

export interface ConfigurationApplyResult {
  readonly previousRevision: string | null;
  readonly acceptedRevision: string;
  readonly entries: readonly ConfigurationApplyEntry[];
  readonly profiles: readonly ProfileHealth[];
}

export interface SupervisorStatus {
  readonly liveness: SupervisorLiveness;
  readonly bridgeVersion: string;
  readonly configurationRevision: string | null;
  readonly profiles: readonly ProfileHealth[];
}

export interface ConfigurationPreview {
  readonly previousRevision: string | null;
  readonly candidateRevision: string;
  readonly entries: readonly ConfigurationApplyEntry[];
}

export type ProfileMaintenanceOperation<T> = (
  profile: Readonly<ProfileConfiguration>
) => Promise<T>;

export interface ProfileMaintenanceHold {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly token: string;
  readonly purpose: "backup";
  readonly createdAtMs: number;
  readonly drainCompleted: boolean;
}

export interface WorkerRestartPolicy {
  readonly delaysMs: readonly number[];
  readonly windowMs: number;
  readonly cooldownMs: number;
}

export interface SupervisorClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

const defaultRestartPolicy: WorkerRestartPolicy = {
  delaysMs: [1_000, 2_000, 5_000],
  windowMs: 60_000,
  cooldownMs: 30_000
};

const defaultClock: SupervisorClock = {
  now: () => Date.now(),
  sleep: (delayMs) => new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  })
};

export class Supervisor extends EventEmitter {
  readonly #factory: ProfileRuntimeFactory;
  readonly #restartPolicy: WorkerRestartPolicy;
  readonly #clock: SupervisorClock;
  readonly #runtimes = new Map<string, ProfileRuntime>();
  readonly #health = new Map<string, ProfileHealth>();
  readonly #unsubscribers = new Map<string, () => void>();
  readonly #workerCrashes = new Map<string, number[]>();
  readonly #maintenanceHolds = new Map<string, ProfileMaintenanceHold>();
  #candidate?: ConfigurationCandidate;
  #liveness: SupervisorLiveness = "starting";
  #operation: Promise<unknown> = Promise.resolve();

  public constructor(
    factory: ProfileRuntimeFactory = new ForkedProfileRuntimeFactory(),
    restartPolicy: WorkerRestartPolicy = defaultRestartPolicy,
    clock: SupervisorClock = defaultClock
  ) {
    super();
    this.#factory = factory;
    this.#restartPolicy = restartPolicy;
    this.#clock = clock;
  }

  public status(): SupervisorStatus {
    return {
      liveness: this.#liveness,
      bridgeVersion: BRIDGE_VERSION,
      configurationRevision: this.#candidate?.revision ?? null,
      profiles: [...this.#health.values()].sort((left, right) =>
        left.profileId.localeCompare(right.profileId)
      )
    };
  }

  public apply(candidate: ConfigurationCandidate): Promise<ConfigurationApplyResult> {
    const operation = this.#operation.then(() => this.#apply(candidate));
    this.#operation = operation.catch(() => undefined);
    return operation;
  }

  public preview(candidate: ConfigurationCandidate): ConfigurationPreview {
    return {
      previousRevision: this.#candidate?.revision ?? null,
      candidateRevision: candidate.revision,
      entries: planConfiguration(this.#candidate, candidate)
    };
  }

  public profileConfiguration(profileId: string): Readonly<ProfileConfiguration> | undefined {
    const profile = this.#candidate?.configuration.profiles[profileId];
    return profile ? { ...profile } : undefined;
  }

  public maintainProfile<T>(
    profileId: string,
    operation: ProfileMaintenanceOperation<T>
  ): Promise<T> {
    const maintenance = this.#operation.then(() => this.#maintainProfile(profileId, operation));
    this.#operation = maintenance.catch(() => undefined);
    return maintenance;
  }

  public holdProfile(profileId: string, purpose: "backup" = "backup"): Promise<ProfileMaintenanceHold> {
    const operation = this.#operation.then(() => this.#holdProfile(profileId, purpose));
    this.#operation = operation.catch(() => undefined);
    return operation;
  }

  public releaseProfileHold(profileId: string, token: string): Promise<ProfileHealth> {
    const operation = this.#operation.then(() => this.#releaseProfileHold(profileId, token));
    this.#operation = operation.catch(() => undefined);
    return operation;
  }

  public async profileHold(profileId: string): Promise<ProfileMaintenanceHold | null> {
    const profile = this.#candidate?.configuration.profiles[profileId];
    if (!profile) throw new Error("Profile is not configured");
    return this.#maintenanceHolds.get(profileId) ?? await readMaintenanceHold(profile);
  }

  public executeWhatsAppAccountAction(
    profileId: string,
    channelAccountId: string,
    action: WhatsAppChannelAccountAction,
    onEvent?: (event: WhatsAppChannelAccountEvent) => Promise<void> | void
  ): Promise<WhatsAppChannelAccountResult> {
    if (this.#liveness !== "live") throw new Error("Supervisor is not live");
    const profile = this.#candidate?.configuration.profiles[profileId];
    if (!profile?.enabled) throw new Error("Profile is not enabled");
    const runtime = this.#runtimes.get(profileId);
    if (!runtime) throw new Error("Profile worker is unavailable");
    return runtime.executeWhatsAppAccountAction(channelAccountId, action, onEvent);
  }

  public executeCodexCircuitReset(profileId: string): Promise<CodexCircuitResetResult> {
    if (this.#liveness !== "live") throw new Error("Supervisor is not live");
    const profile = this.#candidate?.configuration.profiles[profileId];
    if (!profile?.enabled) throw new Error("Profile is not enabled");
    const runtime = this.#runtimes.get(profileId);
    if (!runtime) throw new Error("Profile worker is unavailable");
    return runtime.resetCodexCircuit();
  }

  public stop(): Promise<SupervisorStatus> {
    const operation = this.#operation.then(() => this.#stop());
    this.#operation = operation.catch(() => undefined);
    return operation;
  }

  async #apply(candidate: ConfigurationCandidate): Promise<ConfigurationApplyResult> {
    if (this.#liveness === "stopping" || this.#liveness === "stopped") {
      throw new Error("Supervisor is stopping or stopped");
    }
    const previous = this.#candidate;
    const entries = planConfiguration(previous, candidate);
    for (const [profileId] of this.#maintenanceHolds) {
      const before = previous?.configuration.profiles[profileId];
      const after = candidate.configuration.profiles[profileId];
      if (!before || !after || !sameRestartConfiguration(before, after)) {
        throw new Error(`Profile ${profileId} configuration cannot change during a maintenance hold`);
      }
    }

    // Acceptance is transactional: no runtime transition begins before the
    // complete candidate has been parsed and assigned a Configuration Revision.
    this.#candidate = candidate;
    this.#liveness = "live";
    for (const entry of entries) {
      if (entry.action !== "unchanged") this.#workerCrashes.delete(entry.profileId);
    }

    const stopEntries = entries.filter((entry) => entry.action === "stop" || entry.action === "restart");
    await Promise.all(stopEntries.map((entry) => this.#stopProfile(entry.profileId)));

    const starts: Promise<void>[] = [];
    for (const entry of entries) {
      const profile = candidate.configuration.profiles[entry.profileId];
      if (entry.action === "start" || entry.action === "restart") {
        if (profile?.enabled) starts.push(this.#startProfile(profile, candidate));
      } else if (entry.action === "unchanged" && profile && !profile.enabled) {
        this.#setHealth({ profileId: profile.id, readiness: "stopped", reason: null });
      }
    }
    await Promise.all(starts);

    await Promise.all(
      entries
        .filter((entry) => entry.action === "start" || entry.action === "restart")
        .map(async (entry) => {
          const runtime = this.#runtimes.get(entry.profileId);
          if (runtime) await waitUntilSettled(runtime);
        })
    );

    for (const entry of entries) {
      if (!candidate.configuration.profiles[entry.profileId]) {
        this.#health.delete(entry.profileId);
      }
    }

    return {
      previousRevision: previous?.revision ?? null,
      acceptedRevision: candidate.revision,
      entries,
      profiles: this.status().profiles
    };
  }

  async #startProfile(
    profile: ProfileConfiguration,
    candidate: ConfigurationCandidate
  ): Promise<void> {
    try {
      const hold = await readMaintenanceHold(profile);
      if (hold) {
        this.#maintenanceHolds.set(profile.id, hold);
        this.#setHealth({ profileId: profile.id, readiness: "stopped", reason: "maintenance_hold" });
        return;
      }
      const runtime = this.#factory.create(profile, candidate.configuration.supervisor);
      this.#runtimes.set(profile.id, runtime);
      const unsubscribe = runtime.subscribe((health) =>
        this.#handleRuntimeHealth(profile.id, runtime, health)
      );
      this.#unsubscribers.set(profile.id, unsubscribe);
      this.#setHealth(await runtime.start());
    } catch {
      this.#setHealth({ profileId: profile.id, readiness: "unavailable", reason: "worker_start_failed" });
    }
  }

  async #stopProfile(profileId: string): Promise<void> {
    const runtime = this.#runtimes.get(profileId);
    if (!runtime) return;
    try {
      this.#setHealth(await runtime.stop());
    } catch {
      this.#setHealth({ profileId, readiness: "stopped", reason: "worker_stop_timeout" });
    }
    this.#unsubscribers.get(profileId)?.();
    this.#unsubscribers.delete(profileId);
    this.#runtimes.delete(profileId);
  }

  async #stop(): Promise<SupervisorStatus> {
    if (this.#liveness === "stopped") return this.status();
    this.#liveness = "stopping";
    await Promise.all([...this.#runtimes.keys()].map((profileId) => this.#stopProfile(profileId)));
    this.#liveness = "stopped";
    return this.status();
  }

  async #maintainProfile<T>(
    profileId: string,
    operation: ProfileMaintenanceOperation<T>
  ): Promise<T> {
    if (this.#liveness !== "live") throw new Error("Supervisor is not live");
    const candidate = this.#candidate;
    const profile = candidate?.configuration.profiles[profileId];
    if (!candidate || !profile) throw new Error("Profile is not configured");
    const health = this.#health.get(profileId);
    const eligible =
      health?.readiness === "stopped" ||
      (health?.readiness === "unavailable" && health.reason === "migration_required");
    if (!eligible) {
      throw new Error("Profile must be stopped or unavailable with migration_required");
    }

    await this.#stopProfile(profileId);
    try {
      return await operation({ ...profile });
    } finally {
      if (profile.enabled && this.#liveness === "live") await this.#startProfile(profile, candidate);
    }
  }

  async #holdProfile(profileId: string, purpose: "backup"): Promise<ProfileMaintenanceHold> {
    if (this.#liveness !== "live") throw new Error("Supervisor is not live");
    const profile = this.#candidate?.configuration.profiles[profileId];
    if (!profile) throw new Error("Profile is not configured");
    const existing = this.#maintenanceHolds.get(profileId) ?? await readMaintenanceHold(profile);
    if (existing) {
      this.#maintenanceHolds.set(profileId, existing);
      throw new Error(`Profile ${profileId} already has a maintenance hold`);
    }
    const hold: ProfileMaintenanceHold = {
      schemaVersion: 1,
      profileId,
      token: randomUUID(),
      purpose,
      createdAtMs: this.#clock.now(),
      drainCompleted: false
    };
    await writeMaintenanceHold(profile, hold);
    this.#maintenanceHolds.set(profileId, hold);
    await this.#stopProfile(profileId);
    const stopped = this.#health.get(profileId);
    if (stopped?.reason === "worker_stop_timeout") return hold;
    const drainedHold = { ...hold, drainCompleted: true };
    await writeMaintenanceHold(profile, drainedHold);
    this.#maintenanceHolds.set(profileId, drainedHold);
    this.#setHealth({
      profileId,
      readiness: "stopped",
      reason: "maintenance_hold",
      ...(stopped?.codexVersion ? { codexVersion: stopped.codexVersion } : {}),
      ...(stopped?.codexVerification ? { codexVerification: stopped.codexVerification } : {})
    });
    return drainedHold;
  }

  async #releaseProfileHold(profileId: string, token: string): Promise<ProfileHealth> {
    if (this.#liveness !== "live") throw new Error("Supervisor is not live");
    const candidate = this.#candidate;
    const profile = candidate?.configuration.profiles[profileId];
    if (!candidate || !profile) throw new Error("Profile is not configured");
    const hold = this.#maintenanceHolds.get(profileId) ?? await readMaintenanceHold(profile);
    if (!hold) throw new Error(`Profile ${profileId} has no maintenance hold`);
    if (hold.token !== token) throw new Error("Maintenance hold token did not match");
    await removeMaintenanceHold(profile);
    this.#maintenanceHolds.delete(profileId);
    if (!profile.enabled) {
      const health = { profileId, readiness: "stopped" as const, reason: null };
      this.#setHealth(health);
      return health;
    }
    await this.#startProfile(profile, candidate);
    return this.#health.get(profileId) ?? {
      profileId,
      readiness: "unavailable",
      reason: "worker_start_failed"
    };
  }

  #setHealth(health: ProfileHealth): void {
    const previous = this.#health.get(health.profileId);
    if (previous && sameHealth(previous, health)) return;
    this.#health.set(health.profileId, { ...health });
    this.emit("health", { ...health });
  }

  #handleRuntimeHealth(
    profileId: string,
    runtime: ProfileRuntime,
    health: ProfileHealth
  ): void {
    if (this.#runtimes.get(profileId) !== runtime) return;
    this.#setHealth(health);
    if (
      this.#liveness === "live" &&
      health.readiness === "unavailable" &&
      health.reason === "worker_process_exit"
    ) {
      this.#scheduleWorkerRestart(profileId, runtime);
    }
  }

  #scheduleWorkerRestart(profileId: string, runtime: ProfileRuntime): void {
    const now = this.#clock.now();
    const crashes = (this.#workerCrashes.get(profileId) ?? []).filter(
      (timestamp) => now - timestamp <= this.#restartPolicy.windowMs
    );
    crashes.push(now);
    this.#workerCrashes.set(profileId, crashes);
    const delayMs = this.#restartPolicy.delaysMs[crashes.length - 1];
    if (delayMs === undefined) {
      this.#setHealth({
        ...runtime.health(),
        readiness: "unavailable",
        reason: "worker_restart_exhausted"
      });
      void this.#clock.sleep(this.#restartPolicy.cooldownMs).then(() => {
        const operation = this.#operation.then(async () => {
          if (this.#liveness !== "live" || this.#runtimes.get(profileId) !== runtime) return;
          this.#workerCrashes.delete(profileId);
          await this.#restartCrashedProfile(profileId, runtime);
        });
        this.#operation = operation.catch(() => undefined);
      });
      return;
    }

    void this.#clock.sleep(delayMs).then(() => {
      const operation = this.#operation.then(() =>
        this.#restartCrashedProfile(profileId, runtime)
      );
      this.#operation = operation.catch(() => undefined);
    });
  }

  async #restartCrashedProfile(profileId: string, crashedRuntime: ProfileRuntime): Promise<void> {
    if (
      this.#liveness !== "live" ||
      this.#runtimes.get(profileId) !== crashedRuntime ||
      this.#maintenanceHolds.has(profileId)
    ) return;
    const candidate = this.#candidate;
    const profile = candidate?.configuration.profiles[profileId];
    if (!candidate || !profile?.enabled) return;
    this.#unsubscribers.get(profileId)?.();
    this.#unsubscribers.delete(profileId);
    this.#runtimes.delete(profileId);
    await this.#startProfile(profile, candidate);
  }
}

const MAINTENANCE_HOLD_FILE = "maintenance-hold.json";

async function readMaintenanceHold(
  profile: Pick<ProfileConfiguration, "id" | "stateDirectory">
): Promise<ProfileMaintenanceHold | null> {
  const path = maintenanceHoldPath(profile);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Invalid maintenance hold file");
  if (
    process.platform !== "win32" &&
    (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600)
  ) throw new Error("Maintenance hold file is not owner-only");
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<ProfileMaintenanceHold>;
  if (
    value.schemaVersion !== 1 ||
    value.profileId !== profile.id ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    value.purpose !== "backup" ||
    typeof value.drainCompleted !== "boolean" ||
    !Number.isSafeInteger(value.createdAtMs) ||
    (value.createdAtMs ?? -1) < 0
  ) throw new Error("Maintenance hold file is invalid");
  return value as ProfileMaintenanceHold;
}

async function writeMaintenanceHold(
  profile: Pick<ProfileConfiguration, "id" | "stateDirectory">,
  hold: ProfileMaintenanceHold
): Promise<void> {
  const path = maintenanceHoldPath(profile);
  await requireOwnerDirectory(profile.stateDirectory);
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(hold)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function removeMaintenanceHold(
  profile: Pick<ProfileConfiguration, "id" | "stateDirectory">
): Promise<void> {
  await unlink(maintenanceHoldPath(profile));
  await syncDirectory(profile.stateDirectory);
}

function maintenanceHoldPath(profile: Pick<ProfileConfiguration, "stateDirectory">): string {
  if (!isAbsolute(profile.stateDirectory)) throw new Error("Profile state directory must be absolute");
  return join(profile.stateDirectory, MAINTENANCE_HOLD_FILE);
}

async function requireOwnerDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Invalid Profile state directory");
  if (
    process.platform !== "win32" &&
    (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)
  ) throw new Error("Profile state directory is not owner-only");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sameHealth(left: ProfileHealth, right: ProfileHealth): boolean {
  return (
    left.profileId === right.profileId &&
    left.readiness === right.readiness &&
    left.reason === right.reason &&
    left.codexVersion === right.codexVersion &&
    left.codexVerification === right.codexVerification
  );
}

export function planConfiguration(
  previous: ConfigurationCandidate | undefined,
  next: ConfigurationCandidate
): readonly ConfigurationApplyEntry[] {
  const previousProfiles = previous?.configuration.profiles ?? {};
  const nextProfiles = next.configuration.profiles;
  const ids = new Set([...Object.keys(previousProfiles), ...Object.keys(nextProfiles)]);
  return [...ids]
    .sort()
    .map((profileId): ConfigurationApplyEntry => {
      const before = previousProfiles[profileId];
      const after = nextProfiles[profileId];
      if (!after || !after.enabled) {
        return { profileId, action: before?.enabled ? "stop" : "unchanged" };
      }
      if (!before || !before.enabled) return { profileId, action: "start" };
      return {
        profileId,
        action: sameRestartConfiguration(before, after) ? "unchanged" : "restart"
      };
    });
}

function sameRestartConfiguration(
  left: ProfileConfiguration,
  right: ProfileConfiguration
): boolean {
  return (
    left.workspace === right.workspace &&
    left.codexHome === right.codexHome &&
    left.stateDirectory === right.stateDirectory &&
    left.secretsFile === right.secretsFile &&
    JSON.stringify(left.channelAccounts) === JSON.stringify(right.channelAccounts) &&
    JSON.stringify(left.admission) === JSON.stringify(right.admission) &&
    JSON.stringify(left.approval) === JSON.stringify(right.approval) &&
    JSON.stringify(left.media) === JSON.stringify(right.media) &&
    left.codexExecutable === right.codexExecutable
  );
}

async function waitUntilSettled(runtime: ProfileRuntime): Promise<void> {
  if (["ready", "degraded", "unavailable"].includes(runtime.health().readiness)) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = runtime.subscribe((health) => {
      if (!["ready", "degraded", "unavailable"].includes(health.readiness)) return;
      unsubscribe();
      resolve();
    });
  });
}
