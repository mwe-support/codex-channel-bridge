import assert from "node:assert/strict";
import test from "node:test";

import {
  parseConfiguration,
  type ConfigurationCandidate,
  type ProfileConfiguration,
  type SupervisorConfiguration
} from "@codex-channel-bridge/config";
import type { ProfileHealth } from "@codex-channel-bridge/core";
import {
  Supervisor,
  type ProfileRuntime,
  type ProfileRuntimeFactory
} from "@codex-channel-bridge/supervisor";

import { AdministrationError, SupervisorAdministration } from "./administration.js";

class ReadyRuntime implements ProfileRuntime {
  readonly #listeners = new Set<(health: ProfileHealth) => void>();
  #health: ProfileHealth;

  public constructor(profileId: string) {
    this.#health = { profileId, readiness: "stopped", reason: null };
  }

  async start(): Promise<ProfileHealth> {
    return this.#set({ ...this.#health, readiness: "ready", reason: null });
  }

  async stop(): Promise<ProfileHealth> {
    return this.#set({ ...this.#health, readiness: "stopped", reason: null });
  }

  health(): ProfileHealth {
    return { ...this.#health };
  }

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

const factory: ProfileRuntimeFactory = {
  create: (profile: ProfileConfiguration, _settings: SupervisorConfiguration) =>
    new ReadyRuntime(profile.id)
};

function candidate(workspace: string): ConfigurationCandidate {
  return parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: ${workspace}
    codexHome: /srv/alpha/codex
    stateDirectory: /srv/alpha/state
`);
}

function request(method: "status/get" | "config/plan" | "config/apply", params?: unknown) {
  return { version: 1 as const, id: "request-1", method, params };
}

test("requires the full candidate revision before applying a stored plan", async () => {
  const supervisor = new Supervisor(factory);
  const initial = candidate("/srv/alpha/old");
  const next = candidate("/srv/alpha/new");
  await supervisor.apply(initial);
  const administration = new SupervisorAdministration(supervisor, {
    loadCandidate: async () => next,
    now: () => 1_000
  });

  const plan = (await administration.handle(
    request("config/plan", { configPath: "/tmp/config.yaml" })
  )) as { planToken: string; candidateRevision: string };
  await assert.rejects(
    () =>
      administration.handle(
        request("config/apply", {
          planToken: plan.planToken,
          confirmRevision: "wrong"
        })
      ),
    (error: unknown) =>
      error instanceof AdministrationError && error.code === "confirmation_mismatch"
  );
  assert.equal(supervisor.status().configurationRevision, initial.revision);

  const confirmedPlan = (await administration.handle(
    request("config/plan", { configPath: "/tmp/config.yaml" })
  )) as { planToken: string; candidateRevision: string };
  await administration.handle(
    request("config/apply", {
      planToken: confirmedPlan.planToken,
      confirmRevision: confirmedPlan.candidateRevision
    })
  );
  assert.equal(supervisor.status().configurationRevision, next.revision);
  await supervisor.stop();
});

test("rejects an expired or stale plan without changing runtime state", async () => {
  const supervisor = new Supervisor(factory);
  const initial = candidate("/srv/alpha/old");
  const planned = candidate("/srv/alpha/planned");
  const other = candidate("/srv/alpha/other");
  await supervisor.apply(initial);
  let now = 1_000;
  const administration = new SupervisorAdministration(supervisor, {
    loadCandidate: async () => planned,
    now: () => now,
    planLifetimeMs: 100
  });
  const expired = (await administration.handle(
    request("config/plan", { configPath: "/tmp/config.yaml" })
  )) as { planToken: string; candidateRevision: string };
  now = 1_101;
  await assert.rejects(
    () =>
      administration.handle(
        request("config/apply", {
          planToken: expired.planToken,
          confirmRevision: expired.candidateRevision
        })
      ),
    (error: unknown) => error instanceof AdministrationError && error.code === "plan_expired"
  );

  now = 2_000;
  const stale = (await administration.handle(
    request("config/plan", { configPath: "/tmp/config.yaml" })
  )) as { planToken: string; candidateRevision: string };
  await supervisor.apply(other);
  await assert.rejects(
    () =>
      administration.handle(
        request("config/apply", {
          planToken: stale.planToken,
          confirmRevision: stale.candidateRevision
        })
      ),
    (error: unknown) => error instanceof AdministrationError && error.code === "plan_stale"
  );
  assert.equal(supervisor.status().configurationRevision, other.revision);
  await supervisor.stop();
});
