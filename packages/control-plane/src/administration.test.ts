import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { secureWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

import Database from "better-sqlite3";

import {
  parseConfiguration,
  type ConfigurationCandidate,
  type ProfileConfiguration,
  type SupervisorConfiguration
} from "@codex-channel-bridge/config";
import type { ProfileHealth } from "@codex-channel-bridge/core";
import { SqliteProfileStore } from "@codex-channel-bridge/profile-store";
import {
  Supervisor,
  type WhatsAppChannelAccountEvent,
  type ProfileRuntime,
  type ProfileRuntimeFactory
} from "@codex-channel-bridge/supervisor";

import { AdministrationError, SupervisorAdministration } from "./administration.js";
import type { AdministrationMethod } from "./protocol.js";

class ReadyRuntime implements ProfileRuntime {
  readonly #listeners = new Set<(health: ProfileHealth) => void>();
  #health: ProfileHealth;
  readonly whatsappActions: unknown[] = [];

  public constructor(profileId: string) {
    this.#health = { profileId, readiness: "stopped", reason: null };
  }

  async start(): Promise<ProfileHealth> {
    return this.#set({ ...this.#health, readiness: "ready", reason: null });
  }

  async stop(): Promise<ProfileHealth> {
    return this.#set({ ...this.#health, readiness: "stopped", reason: null });
  }

  async executeWhatsAppAccountAction(
    _channelAccountId: string,
    action: unknown,
    onEvent?: (event: WhatsAppChannelAccountEvent) => Promise<void> | void
  ) {
    this.whatsappActions.push(action);
    if ((action as { kind?: string }).kind === "pair") {
      await onEvent?.({
        kind: "pairing_material",
        material: { kind: "qr", value: "sensitive-test-qr", expiresAtMs: 10_000 }
      });
      return { kind: "paired" as const, generationId: "generation-1" };
    }
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

function request(method: AdministrationMethod, params?: unknown) {
  return { version: 1 as const, id: "request-1", method, params };
}

test("plans and applies one stopped Profile migration with snapshot evidence", async (context) => {
  const directory = await schemaThreeState(context);
  const disabled = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    enabled: false
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: ${directory}
`);
  const supervisor = new Supervisor(factory);
  await supervisor.apply(disabled);
  const administration = new SupervisorAdministration(supervisor, { now: () => 10_000 });

  const plan = (await administration.handle(
    request("migrate/plan", { profileId: "alpha" })
  )) as {
    planToken: string;
    planDigest: string;
    sourceDigest: string;
    migrationRequired: boolean;
  };
  assert.equal(plan.migrationRequired, true);
  const manifestPath = join(directory, "snapshot-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "codex-channel-bridge-profile-snapshot",
      profileId: "alpha",
      sourceDigest: plan.sourceDigest,
      completedAtMs: 9_000
    })}\n`,
    { mode: 0o600 }
  );
  await chmod(manifestPath, 0o600);

  const result = (await administration.handle(
    request("migrate/apply", {
      planToken: plan.planToken,
      confirmPlanDigest: plan.planDigest,
      backupManifestPath: manifestPath,
      snapshotConfirmed: true
    })
  )) as { fromVersion: number; toVersion: number };
  assert.deepEqual(result, {
    ...result,
    fromVersion: 3,
    toVersion: 11
  });
  SqliteProfileStore.open({
    profileId: "alpha",
    databasePath: join(directory, "bridge.sqlite")
  }).close();
  assert.equal(supervisor.status().profiles[0]?.readiness, "stopped");
  await supervisor.stop();
});

test("requires explicit snapshot confirmation before migration", async (context) => {
  const directory = await schemaThreeState(context);
  const disabled = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    enabled: false
    workspace: /srv/alpha/workspace
    codexHome: /srv/alpha/codex
    stateDirectory: ${directory}
`);
  const supervisor = new Supervisor(factory);
  await supervisor.apply(disabled);
  const administration = new SupervisorAdministration(supervisor);
  const plan = (await administration.handle(
    request("migrate/plan", { profileId: "alpha" })
  )) as { planToken: string; planDigest: string };
  await assert.rejects(
    administration.handle(
      request("migrate/apply", {
        planToken: plan.planToken,
        confirmPlanDigest: plan.planDigest,
        backupManifestPath: join(directory, "missing.json"),
        snapshotConfirmed: false
      })
    ),
    (error: unknown) => error instanceof AdministrationError && error.code === "invalid_params"
  );
  const database = new Database(join(directory, "bridge.sqlite"), { readonly: true });
  assert.equal(database.pragma("user_version", { simple: true }), 3);
  database.close();
  await supervisor.stop();
});

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

test("forwards only short-lived WhatsApp pairing material to the initiating administration call", async () => {
  const runtimes: ReadyRuntime[] = [];
  const supervisor = new Supervisor({
    create: (profile) => {
      const runtime = new ReadyRuntime(profile.id);
      runtimes.push(runtime);
      return runtime;
    }
  });
  await supervisor.apply(candidate("/srv/alpha/workspace"));
  const administration = new SupervisorAdministration(supervisor);
  const events: WhatsAppChannelAccountEvent[] = [];
  assert.deepEqual(
    await administration.handle(
      request("whatsapp/pair", {
        profileId: "alpha",
        channelAccountId: "wa-primary",
        timeoutMs: 5_000
      }),
      async (event) => {
        events.push(event);
      }
    ),
    { kind: "paired", generationId: "generation-1" }
  );
  assert.equal(events[0]?.material.value, "sensitive-test-qr");
  assert.deepEqual(runtimes[0]?.whatsappActions, [{ kind: "pair", timeoutMs: 5_000 }]);
  await supervisor.stop();
});

test("plans and applies Archive purge only through a stopped Profile boundary", async (context) => {
  const fixture = await purgeState(context);
  const supervisor = new Supervisor(factory);
  await supervisor.apply(fixture.candidate);
  const administration = new SupervisorAdministration(supervisor, { now: () => 5_000 });
  const plan = (await administration.handle(request("archive/purge-plan", {
    profileId: "alpha",
    scope: "profile"
  }))) as { planToken: string; profileId: string; messageCount: number };
  assert.equal(plan.messageCount, 1);
  const result = (await administration.handle(request("archive/purge-apply", {
    planToken: plan.planToken,
    confirmProfileId: plan.profileId,
    confirmMessageCount: plan.messageCount
  }))) as { messageCount: number; mediaCleanupFailures: number };
  assert.deepEqual(
    { messageCount: result.messageCount, mediaCleanupFailures: result.mediaCleanupFailures },
    { messageCount: 1, mediaCleanupFailures: 0 }
  );
  const store = SqliteProfileStore.open({
    profileId: "alpha",
    databasePath: join(fixture.stateDirectory, "bridge.sqlite")
  });
  assert.equal(store.recentMessages("qq:private:conversation-1").length, 0);
  assert.equal(store.auditRecords()[0]?.action, "archive_purge");
  store.close();
  await supervisor.stop();
});

test("plans and applies permanent Profile purge with exact identity confirmation", async (context) => {
  const fixture = await purgeState(context);
  const supervisor = new Supervisor(factory);
  await supervisor.apply(fixture.candidate);
  const administration = new SupervisorAdministration(supervisor, { now: () => 6_000 });
  const plan = (await administration.handle(request("profile/purge-plan", {
    profileId: "alpha"
  }))) as { planToken: string; profileId: string; tombstonePath: string };
  const result = (await administration.handle(request("profile/purge-apply", {
    planToken: plan.planToken,
    confirmProfileId: plan.profileId
  }))) as { profileId: string };
  assert.equal(result.profileId, "alpha");
  await assert.rejects(stat(fixture.stateDirectory));
  assert.equal((await stat(fixture.workspace)).isDirectory(), true);
  assert.equal((await stat(fixture.codexHome)).isDirectory(), true);
  assert.match(await readFile(plan.tombstonePath, "utf8"), /"result":"succeeded"/u);
  await supervisor.stop();
});

async function purgeState(context: test.TestContext): Promise<{
  readonly candidate: ConfigurationCandidate;
  readonly stateDirectory: string;
  readonly workspace: string;
  readonly codexHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bridge-control-purge-"));
  secureWindowsOwnerOnlyPath(root, "directory");
  await chmod(root, 0o700);
  context.after(async () => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  await Promise.all([
    mkdir(stateDirectory, { mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 }),
    mkdir(codexHome, { mode: 0o700 })
  ]);
  const store = SqliteProfileStore.open({
    profileId: "alpha",
    databasePath: join(stateDirectory, "bridge.sqlite")
  });
  store.commitMessage({
    profileId: "alpha",
    provider: "qq",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    providerEventId: "event-1",
    conversationKey: "qq:private:conversation-1",
    conversationKind: "private",
    providerConversationId: "conversation-1",
    providerIdentity: "participant-1",
    observedAtMs: 1_000,
    text: "purge test"
  });
  store.close();
  return {
    candidate: parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    enabled: false
    workspace: ${workspace}
    codexHome: ${codexHome}
    stateDirectory: ${stateDirectory}
`),
    stateDirectory,
    workspace,
    codexHome
  };
}

async function schemaThreeState(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-control-migration-"));
  secureWindowsOwnerOnlyPath(directory, "directory");
  await chmod(directory, 0o700);
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "bridge.sqlite");
  SqliteProfileStore.open({ profileId: "alpha", databasePath }).close();
  const database = new Database(databasePath);
  database.exec("ALTER TABLE delivery_outbox DROP COLUMN file_json; DROP TABLE answer_streams; DROP TABLE archive_attachments");
  database.exec("ALTER TABLE delivery_outbox DROP COLUMN provider_reply_text_body");
  database.exec("ALTER TABLE delivery_outbox DROP COLUMN provider_reply_participant_id");
  downgradeFiveToFour(database);
  database.exec("DROP TABLE delivery_reply_sequences");
  database.exec("ALTER TABLE delivery_outbox DROP COLUMN provider_reply_sequence");
  database.pragma("user_version = 3");
  database.close();
  await chmod(databasePath, 0o600);
  return directory;
}

function downgradeFiveToFour(database: Database.Database): void {
  database.pragma("foreign_keys = OFF");
  database.exec(`
    DROP TABLE channel_transport_checkpoints;
    DROP TABLE audit_records;
    DROP TABLE approval_requests;

    ALTER TABLE message_archive DROP COLUMN provider_conversation_id;
    CREATE TABLE logical_results_v4 (
      row_id INTEGER PRIMARY KEY,
      logical_result_id TEXT NOT NULL UNIQUE,
      profile_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL,
      completed_at_ms INTEGER NOT NULL,
      payload_digest TEXT NOT NULL,
      segment_count INTEGER NOT NULL CHECK (segment_count > 0),
      UNIQUE (profile_id, codex_thread_id, codex_turn_id)
    );
    INSERT INTO logical_results_v4 (
      row_id, logical_result_id, profile_id, codex_thread_id, codex_turn_id,
      completed_at_ms, payload_digest, segment_count
    )
    SELECT row_id, logical_result_id, profile_id, codex_thread_id, codex_turn_id,
           completed_at_ms, payload_digest, segment_count
      FROM logical_results WHERE source_kind = 'codex_turn';
    CREATE TABLE delivery_outbox_v4 (
      row_id INTEGER PRIMARY KEY,
      outbox_record_id TEXT NOT NULL UNIQUE,
      logical_result_id TEXT NOT NULL REFERENCES logical_results_v4(logical_result_id),
      profile_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
      provider TEXT NOT NULL CHECK (provider IN ('qq', 'whatsapp')),
      channel_account_id TEXT NOT NULL,
      channel_account_epoch_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('private', 'group')),
      provider_conversation_id TEXT NOT NULL,
      provider_reply_event_id TEXT,
      provider_reply_sequence INTEGER CHECK (
        provider_reply_sequence IS NULL OR provider_reply_sequence > 0
      ),
      text_body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'leased', 'retry_wait', 'accepted', 'rejected')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at_ms INTEGER NOT NULL,
      lease_token TEXT,
      lease_expires_at_ms INTEGER,
      last_outcome TEXT CHECK (
        last_outcome IN ('accepted', 'rejected', 'ambiguous', 'deferred')
      ),
      last_reason_code TEXT,
      provider_message_id TEXT,
      accepted_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE (logical_result_id, segment_index)
    );
    INSERT INTO delivery_outbox_v4 SELECT * FROM delivery_outbox;
    DROP TABLE delivery_outbox;
    DROP TABLE logical_results;
    ALTER TABLE logical_results_v4 RENAME TO logical_results;
    ALTER TABLE delivery_outbox_v4 RENAME TO delivery_outbox;
    CREATE INDEX delivery_outbox_ready
      ON delivery_outbox (profile_id, status, next_attempt_at_ms, created_at_ms);
    PRAGMA user_version = 4;
  `);
  database.pragma("foreign_keys = ON");
}
