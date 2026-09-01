import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseConfiguration,
  type ProfileConfiguration,
  type SupervisorConfiguration
} from "@codex-channel-bridge/config";
import type { ProfileHealth } from "@codex-channel-bridge/core";
import { SqliteProfileStore } from "@codex-channel-bridge/profile-store";
import {
  Supervisor,
  type ProfileRuntime,
  type ProfileRuntimeFactory
} from "@codex-channel-bridge/supervisor";

import { BackupCoordinator, readBackupManifest } from "./backup-coordinator.js";

class Runtime implements ProfileRuntime {
  readonly #listeners = new Set<(health: ProfileHealth) => void>();
  #health: ProfileHealth;

  public constructor(profileId: string) {
    this.#health = { profileId, readiness: "stopped", reason: null };
  }

  async start(): Promise<ProfileHealth> {
    return this.#set({
      profileId: this.#health.profileId,
      readiness: "ready",
      reason: null,
      codexVersion: "0.149.1",
      codexVerification: "tested"
    });
  }

  async stop(): Promise<ProfileHealth> {
    return this.#set({ ...this.#health, readiness: "stopped", reason: null });
  }

  async executeWhatsAppAccountAction(): Promise<never> {
    throw new Error("not used");
  }

  async resetCodexCircuit() { return { kind: "reset" as const }; }

  health(): ProfileHealth { return { ...this.#health }; }

  subscribe(listener: (health: ProfileHealth) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(health: ProfileHealth): ProfileHealth {
    this.#health = health;
    for (const listener of this.#listeners) listener(this.health());
    return this.health();
  }
}

const runtimeFactory: ProfileRuntimeFactory = {
  create(profile: ProfileConfiguration, _supervisor: SupervisorConfiguration): ProfileRuntime {
    return new Runtime(profile.id);
  }
};

test("prepares, validates, and finishes an operator-owned Profile backup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-backup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const stateDirectory = join(root, "state");
  for (const path of [workspace, codexHome, stateDirectory]) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  const candidate = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: ${workspace}
    codexHome: ${codexHome}
    stateDirectory: ${stateDirectory}
`);
  const databasePath = join(stateDirectory, "bridge.sqlite");
  SqliteProfileStore.open({ profileId: "alpha", databasePath }).close();
  const supervisor = new Supervisor(runtimeFactory);
  await supervisor.apply(candidate);
  const coordinator = new BackupCoordinator(supervisor, () => 50_000);
  const manifestPath = join(root, "backup-manifest.json");

  const prepared = await coordinator.prepare({
    profileId: "alpha",
    manifestPath,
    includeWorkspace: true
  });

  assert.equal(supervisor.status().profiles[0]?.reason, "maintenance_hold");
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  const manifest = await readBackupManifest(manifestPath);
  assert.equal(manifest.codexVersion, "0.149.1");
  assert.equal(manifest.snapshotPaths.workspace, workspace);
  assert.equal(manifest.outbox.pending, 0);
  assert.equal(manifest.checkpoint.busy, 0);
  assert.equal((await coordinator.validateRestore({ profileId: "alpha", manifestPath })).valid, true);

  const finished = await coordinator.finish({
    profileId: "alpha",
    manifestPath,
    holdToken: prepared.holdToken,
    snapshotConfirmed: true
  });
  assert.equal(finished.resumed, true);
  assert.equal(supervisor.status().profiles[0]?.readiness, "ready");
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath, readOnly: true });
  assert.deepEqual(store.auditRecords(2).map((record) => record.action), [
    "backup_finish",
    "backup_prepare"
  ]);
  store.close();
  await supervisor.stop();
});

test("rejects a changed backup manifest and preserves the Profile hold", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-backup-change-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const candidate = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    enabled: false
    workspace: ${join(root, "workspace")}
    codexHome: ${join(root, "codex-home")}
    stateDirectory: ${stateDirectory}
`);
  SqliteProfileStore.open({
    profileId: "alpha",
    databasePath: join(stateDirectory, "bridge.sqlite")
  }).close();
  const supervisor = new Supervisor(runtimeFactory);
  await supervisor.apply(candidate);
  const coordinator = new BackupCoordinator(supervisor, () => 60_000);
  const manifestPath = join(root, "manifest.json");
  const prepared = await coordinator.prepare({
    profileId: "alpha",
    manifestPath,
    includeWorkspace: false
  });
  await assert.rejects(
    coordinator.finish({
      profileId: "alpha",
      manifestPath,
      holdToken: "wrong",
      snapshotConfirmed: true
    }),
    /does not match/
  );
  assert.equal(supervisor.status().profiles[0]?.reason, "maintenance_hold");
  await supervisor.releaseProfileHold("alpha", prepared.holdToken);
  await supervisor.stop();
});
