import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";

import {
  parseConfiguration,
  type ProfileConfiguration,
  type SupervisorConfiguration
} from "@codex-channel-bridge/config";
import { BRIDGE_VERSION, type ProfileHealth } from "@codex-channel-bridge/core";

import type { ProfileRuntime, ProfileRuntimeFactory } from "./profile-runtime.js";
import {
  Supervisor,
  planConfiguration,
  type SupervisorClock
} from "./supervisor.js";

class FakeRuntime implements ProfileRuntime {
  readonly #listeners = new Set<(health: ProfileHealth) => void>();
  #health: ProfileHealth;
  starts = 0;
  stops = 0;
  readonly whatsappActions: unknown[] = [];

  public constructor(
    readonly profile: ProfileConfiguration,
    private readonly startReadiness: "ready" | "unavailable" = "ready"
  ) {
    this.#health = { profileId: profile.id, readiness: "stopped", reason: null };
  }

  async start(): Promise<ProfileHealth> {
    this.starts += 1;
    return this.#transition({
      profileId: this.profile.id,
      readiness: this.startReadiness,
      reason: this.startReadiness === "ready" ? null : "worker_start_failed"
    });
  }

  async stop(): Promise<ProfileHealth> {
    this.stops += 1;
    return this.#transition({ profileId: this.profile.id, readiness: "stopped", reason: null });
  }

  async executeWhatsAppAccountAction(_channelAccountId: string, action: unknown) {
    this.whatsappActions.push(action);
    return { kind: "connected" as const };
  }

  async resetCodexCircuit() { return { kind: "reset" as const }; }

  health(): ProfileHealth {
    return { ...this.#health };
  }

  subscribe(listener: (health: ProfileHealth) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  crash(): void {
    this.#transition({
      ...this.#health,
      readiness: "unavailable",
      reason: "worker_process_exit"
    });
  }

  #transition(health: ProfileHealth): ProfileHealth {
    this.#health = health;
    for (const listener of this.#listeners) listener(this.health());
    return this.health();
  }
}

class FakeFactory implements ProfileRuntimeFactory {
  readonly created: FakeRuntime[] = [];
  readonly unavailable = new Set<string>();

  create(profile: ProfileConfiguration, _supervisor: SupervisorConfiguration): ProfileRuntime {
    const runtime = new FakeRuntime(
      profile,
      this.unavailable.has(profile.id) ? "unavailable" : "ready"
    );
    this.created.push(runtime);
    return runtime;
  }
}

function candidate(alphaWorkspace = "/srv/alpha/workspace", betaEnabled = true) {
  return parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: ${alphaWorkspace}
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
  beta:
    enabled: ${betaEnabled}
    workspace: /srv/beta/workspace
    codexHome: /srv/beta/codex
    stateDirectory: /srv/beta/state
`);
}

test("keeps Supervisor live when one Profile is unavailable", async () => {
  const factory = new FakeFactory();
  factory.unavailable.add("beta");
  const supervisor = new Supervisor(factory);
  const result = await supervisor.apply(candidate());
  assert.equal(supervisor.status().liveness, "live");
  assert.equal(supervisor.status().bridgeVersion, BRIDGE_VERSION);
  assert.deepEqual(
    result.profiles.map((profile) => [profile.profileId, profile.readiness]),
    [
      ["alpha", "ready"],
      ["beta", "unavailable"]
    ]
  );
  await supervisor.stop();
});

test("restarts only a Profile whose restart-owned configuration changed", async () => {
  const factory = new FakeFactory();
  const supervisor = new Supervisor(factory);
  const first = candidate();
  await supervisor.apply(first);
  const alphaFirst = factory.created.find((runtime) => runtime.profile.id === "alpha")!;
  const betaFirst = factory.created.find((runtime) => runtime.profile.id === "beta")!;

  const second = candidate("/srv/alpha/new-workspace");
  const result = await supervisor.apply(second);
  assert.deepEqual(result.entries, [
    { profileId: "alpha", action: "restart" },
    { profileId: "beta", action: "unchanged" }
  ]);
  assert.equal(alphaFirst.stops, 1);
  assert.equal(betaFirst.stops, 0);
  assert.equal(factory.created.filter((runtime) => runtime.profile.id === "alpha").length, 2);
  await supervisor.stop();
});

test("disabling a Profile stops it without deleting its configuration", async () => {
  const factory = new FakeFactory();
  const supervisor = new Supervisor(factory);
  await supervisor.apply(candidate());
  const beta = factory.created.find((runtime) => runtime.profile.id === "beta")!;
  const result = await supervisor.apply(candidate("/srv/alpha/workspace", false));
  assert(result.entries.some((entry) => entry.profileId === "beta" && entry.action === "stop"));
  assert.equal(beta.stops, 1);
  assert.equal(
    result.profiles.find((profile) => profile.profileId === "beta")?.readiness,
    "stopped"
  );
  await supervisor.stop();
});

test("configuration planning has no runtime side effects", () => {
  const first = candidate();
  const next = candidate("/srv/alpha/new-workspace", false);
  assert.deepEqual(planConfiguration(first, next), [
    { profileId: "alpha", action: "restart" },
    { profileId: "beta", action: "stop" }
  ]);
});

test("treats Profile media bounds as restart-owned configuration", () => {
  const first = candidate();
  const next = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
    media:
      perAttachmentLimitBytes: 1024
      profileQuotaBytes: 4096
  beta:
    workspace: /srv/beta/workspace
    codexHome: /srv/beta/codex
    stateDirectory: /srv/beta/state
`);
  assert.deepEqual(planConfiguration(first, next), [
    { profileId: "alpha", action: "restart" },
    { profileId: "beta", action: "unchanged" }
  ]);
});

test("forwards a WhatsApp lifecycle action only to the selected live Profile", async () => {
  const factory = new FakeFactory();
  const supervisor = new Supervisor(factory);
  await supervisor.apply(candidate());
  assert.deepEqual(
    await supervisor.executeWhatsAppAccountAction("alpha", "wa-primary", { kind: "connect" }),
    { kind: "connected" }
  );
  assert.deepEqual(factory.created.find((runtime) => runtime.profile.id === "alpha")?.whatsappActions, [
    { kind: "connect" }
  ]);
  assert.deepEqual(factory.created.find((runtime) => runtime.profile.id === "beta")?.whatsappActions, []);
  await supervisor.stop();
});

test("removing an already disabled Profile removes only its runtime status", async () => {
  const factory = new FakeFactory();
  const supervisor = new Supervisor(factory);
  await supervisor.apply(candidate("/srv/alpha/workspace", false));
  const withoutBeta = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
`);
  const result = await supervisor.apply(withoutBeta);
  assert.equal(result.profiles.some((profile) => profile.profileId === "beta"), false);
  await supervisor.stop();
});

test("restarts a crashed Worker with a bounded Profile-local budget", async () => {
  const factory = new FakeFactory();
  const cooldown = new Promise<void>(() => undefined);
  const clock: SupervisorClock = {
    now: () => 1_000,
    sleep: (delayMs) => delayMs === 99 ? cooldown : Promise.resolve()
  };
  const supervisor = new Supervisor(
    factory,
    { delaysMs: [0, 0], windowMs: 60_000, cooldownMs: 99 },
    clock
  );
  await supervisor.apply(candidate("/srv/alpha/workspace", false));

  factory.created.at(-1)!.crash();
  await eventually(() => factory.created.length === 2);
  factory.created.at(-1)!.crash();
  await eventually(() => factory.created.length === 3);
  factory.created.at(-1)!.crash();
  await eventually(
    () =>
      supervisor.status().profiles.find((profile) => profile.profileId === "alpha")?.reason ===
      "worker_restart_exhausted"
  );
  assert.equal(factory.created.length, 3);
  assert.equal(supervisor.status().liveness, "live");
  await supervisor.stop();
});

test("retries a Worker only after an exhausted circuit cooldown", async () => {
  const factory = new FakeFactory();
  let releaseCooldown!: () => void;
  const cooldown = new Promise<void>((resolve) => {
    releaseCooldown = resolve;
  });
  const clock: SupervisorClock = {
    now: () => 1_000,
    sleep: (delayMs) => delayMs === 99 ? cooldown : Promise.resolve()
  };
  const supervisor = new Supervisor(
    factory,
    { delaysMs: [0], windowMs: 60_000, cooldownMs: 99 },
    clock
  );
  await supervisor.apply(candidate("/srv/alpha/workspace", false));

  factory.created.at(-1)!.crash();
  await eventually(() => factory.created.length === 2);
  factory.created.at(-1)!.crash();
  await eventually(
    () => supervisor.status().profiles[0]?.reason === "worker_restart_exhausted"
  );
  assert.equal(factory.created.length, 2);

  releaseCooldown();
  await eventually(() => factory.created.length === 3);
  assert.equal(supervisor.status().profiles[0]?.readiness, "ready");
  await supervisor.stop();
});

test("runs Profile maintenance only behind a stopped migration boundary", async () => {
  let starts = 0;
  let stops = 0;
  let current: ProfileHealth = {
    profileId: "alpha",
    readiness: "stopped",
    reason: null
  };
  const listeners = new Set<(health: ProfileHealth) => void>();
  const migrationFactory: ProfileRuntimeFactory = {
    create: () => ({
      async start() {
        starts += 1;
        current = {
          profileId: "alpha",
          readiness: "unavailable",
          reason: "migration_required"
        };
        for (const listener of listeners) listener({ ...current });
        return { ...current };
      },
      async stop() {
        stops += 1;
        current = { profileId: "alpha", readiness: "stopped", reason: null };
        for (const listener of listeners) listener({ ...current });
        return { ...current };
      },
      async executeWhatsAppAccountAction(): Promise<never> {
        throw new Error("not configured in this test");
      },
      async resetCodexCircuit() { return { kind: "reset" as const }; },
      health: () => ({ ...current }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    })
  };
  const supervisor = new Supervisor(migrationFactory);
  await supervisor.apply(candidate("/srv/alpha/workspace", false));
  const result = await supervisor.maintainProfile("alpha", async (profile) => {
    assert.equal(profile.stateDirectory, normalize("/srv/alpha/state"));
    assert.equal(supervisor.status().profiles[0]?.readiness, "stopped");
    return "migrated";
  });
  assert.equal(result, "migrated");
  assert.equal(starts, 2);
  assert.equal(stops, 1);
  assert.equal(supervisor.status().profiles[0]?.reason, "migration_required");
  await supervisor.stop();
});

test("rejects Profile maintenance while the Profile is ready", async () => {
  const supervisor = new Supervisor(new FakeFactory());
  await supervisor.apply(candidate("/srv/alpha/workspace", false));
  await assert.rejects(
    supervisor.maintainProfile("alpha", async () => undefined),
    /must be stopped or unavailable/
  );
  await supervisor.stop();
});

test("durably holds one Profile stopped until the exact token releases it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-hold-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const configuration = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: ${join(root, "workspace")}
    codexHome: ${join(root, "codex-home")}
    stateDirectory: ${stateDirectory}
`);
  const factory = new FakeFactory();
  const supervisor = new Supervisor(factory);
  await supervisor.apply(configuration);

  const hold = await supervisor.holdProfile("alpha");

  assert.equal(supervisor.status().profiles[0]?.readiness, "stopped");
  assert.equal(supervisor.status().profiles[0]?.reason, "maintenance_hold");
  assert.equal(factory.created[0]?.stops, 1);
  assert.equal(
    JSON.parse(await readFile(join(stateDirectory, "maintenance-hold.json"), "utf8")).token,
    hold.token
  );
  await assert.rejects(supervisor.releaseProfileHold("alpha", "wrong"), /token did not match/);
  const resumed = await supervisor.releaseProfileHold("alpha", hold.token);
  assert.equal(resumed.readiness, "ready");
  assert.equal(factory.created.length, 2);
  await supervisor.stop();
});

test("honors a durable maintenance hold after Supervisor restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-hold-restart-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const configuration = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: ${join(root, "workspace")}
    codexHome: ${join(root, "codex-home")}
    stateDirectory: ${stateDirectory}
`);
  const first = new Supervisor(new FakeFactory());
  await first.apply(configuration);
  const hold = await first.holdProfile("alpha");
  await first.stop();

  const restartedFactory = new FakeFactory();
  const restarted = new Supervisor(restartedFactory);
  await restarted.apply(configuration);
  assert.equal(restartedFactory.created.length, 0);
  assert.equal(restarted.status().profiles[0]?.reason, "maintenance_hold");
  await restarted.releaseProfileHold("alpha", hold.token);
  assert.equal(restartedFactory.created.length, 1);
  await restarted.stop();
});

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
}
