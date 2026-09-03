import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  applyProfileStoreMigration,
  planProfileStoreMigration,
  ProfileMigrationError
} from "./migration.js";
import { SqliteProfileStore } from "./profile-store.js";

test("plans and applies the explicit schema 3 to 9 migration", async (context) => {
  const fixture = await schemaThreeFixture(context);
  const target = {
    profileId: "alpha",
    databasePath: fixture.databasePath,
    auditPath: join(fixture.directory, "audit.jsonl")
  };

  const plan = await planProfileStoreMigration(target);
  assert.equal(plan.currentVersion, 3);
  assert.equal(plan.targetVersion, 9);
  assert.equal(plan.migrationRequired, true);
  assert.equal(plan.operations.length, 23);
  assert.equal(plan.irreversibleSteps.length, 9);
  assert.ok(plan.estimatedAdditionalBytes >= 1024 * 1024);

  const result = await applyProfileStoreMigration({
    ...target,
    expectedPlanDigest: plan.planDigest,
    expectedSourceDigest: plan.sourceDigest,
    nowMs: 10_000
  });
  assert.equal(result.fromVersion, 3);
  assert.equal(result.toVersion, 9);
  SqliteProfileStore.open({ profileId: "alpha", databasePath: fixture.databasePath }).close();
  const current = await planProfileStoreMigration(target);
  assert.equal(current.migrationRequired, false);
  const audit = (await readFile(target.auditPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { result: string });
  assert.deepEqual(audit.map((record) => record.result), [
    "started",
    "started",
    "succeeded",
    "started",
    "succeeded",
    "started",
    "succeeded",
    "started",
    "succeeded",
    "started",
    "succeeded",
    "started",
    "succeeded",
    "succeeded"
  ]);
  if (process.platform !== "win32") assert.equal((await stat(target.auditPath)).mode & 0o777, 0o600);
});

test("plans and applies the explicit schema 4 to 9 migration", async (context) => {
  const fixture = await schemaFourFixture(context);
  const target = {
    profileId: "alpha",
    databasePath: fixture.databasePath,
    auditPath: join(fixture.directory, "audit.jsonl")
  };
  const plan = await planProfileStoreMigration(target);
  assert.equal(plan.currentVersion, 4);
  assert.equal(plan.targetVersion, 9);
  assert.equal(plan.operations.length, 19);
  assert.equal(plan.irreversibleSteps.length, 8);
  const result = await applyProfileStoreMigration({
    ...target,
    expectedPlanDigest: plan.planDigest,
    expectedSourceDigest: plan.sourceDigest
  });
  assert.equal(result.fromVersion, 4);
  assert.equal(result.toVersion, 9);
  SqliteProfileStore.open({ profileId: "alpha", databasePath: fixture.databasePath }).close();
});

test("plans and applies the explicit schema 5 to 9 migration", async (context) => {
  const fixture = await currentFixture(context);
  const target = {
    profileId: "alpha",
    databasePath: fixture.databasePath,
    auditPath: join(fixture.directory, "audit.jsonl")
  };
  const plan = await planProfileStoreMigration(target);
  assert.equal(plan.currentVersion, 5);
  assert.equal(plan.targetVersion, 9);
  assert.equal(plan.operations.length, 14);
  assert.equal(plan.irreversibleSteps.length, 6);
  const result = await applyProfileStoreMigration({
    ...target,
    expectedPlanDigest: plan.planDigest,
    expectedSourceDigest: plan.sourceDigest
  });
  assert.equal(result.fromVersion, 5);
  assert.equal(result.toVersion, 9);
  SqliteProfileStore.open({ profileId: "alpha", databasePath: fixture.databasePath }).close();
});

test("plans and applies the explicit schema 6 to 9 migration", async (context) => {
  const fixture = await schemaSixFixture(context);
  const target = {
    profileId: "alpha",
    databasePath: fixture.databasePath,
    auditPath: join(fixture.directory, "audit.jsonl")
  };
  const plan = await planProfileStoreMigration(target);
  assert.equal(plan.currentVersion, 6);
  assert.equal(plan.targetVersion, 9);
  assert.deepEqual(plan.operations, [
    "create durable Channel transport checkpoints",
    "set SQLite user_version to 7",
    "verify profile ownership, schema shape, foreign keys, and quick_check",
    "add durable WhatsApp quoted-reply participant and text fields",
    "set SQLite user_version to 8",
    "verify profile ownership, schema shape, foreign keys, and quick_check",
    "create durable Archive attachment metadata and media state",
    "set SQLite user_version to 9",
    "verify profile ownership, schema shape, foreign keys, and quick_check"
  ]);
  const result = await applyProfileStoreMigration({
    ...target,
    expectedPlanDigest: plan.planDigest,
    expectedSourceDigest: plan.sourceDigest
  });
  assert.equal(result.fromVersion, 6);
  assert.equal(result.toVersion, 9);
  SqliteProfileStore.open({ profileId: "alpha", databasePath: fixture.databasePath }).close();
});

test("plans and applies the explicit schema 7 to 9 migration", async (context) => {
  const fixture = await schemaSevenFixture(context);
  const target = {
    profileId: "alpha",
    databasePath: fixture.databasePath,
    auditPath: join(fixture.directory, "audit.jsonl")
  };
  const plan = await planProfileStoreMigration(target);
  assert.equal(plan.currentVersion, 7);
  assert.deepEqual(plan.operations, [
    "add durable WhatsApp quoted-reply participant and text fields",
    "set SQLite user_version to 8",
    "verify profile ownership, schema shape, foreign keys, and quick_check",
    "create durable Archive attachment metadata and media state",
    "set SQLite user_version to 9",
    "verify profile ownership, schema shape, foreign keys, and quick_check"
  ]);
  const result = await applyProfileStoreMigration({
    ...target,
    expectedPlanDigest: plan.planDigest,
    expectedSourceDigest: plan.sourceDigest
  });
  assert.equal(result.toVersion, 9);
  SqliteProfileStore.open({ profileId: "alpha", databasePath: fixture.databasePath }).close();
});

test("planning leaves the Profile SQLite directory unchanged", async (context) => {
  const fixture = await schemaThreeFixture(context);
  const beforeFiles = await readdir(fixture.directory);
  const before = await stat(fixture.databasePath);
  await planProfileStoreMigration({
    profileId: "alpha",
    databasePath: fixture.databasePath,
    auditPath: join(fixture.directory, "audit.jsonl")
  });
  const after = await stat(fixture.databasePath);
  assert.deepEqual(await readdir(fixture.directory), beforeFiles);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test(
  "planning rejects a symlinked SQLite WAL without following it",
  { skip: process.platform === "win32" },
  async (context) => {
    const fixture = await schemaThreeFixture(context);
    const outside = join(fixture.directory, "outside-wal");
    await writeFile(outside, "not a wal", { mode: 0o600 });
    await symlink(outside, `${fixture.databasePath}-wal`);
    await assert.rejects(
      planProfileStoreMigration({
        profileId: "alpha",
        databasePath: fixture.databasePath,
        auditPath: join(fixture.directory, "audit.jsonl")
      }),
      (error: unknown) =>
        error instanceof ProfileMigrationError && error.reason === "insecure_store_path"
    );
  }
);

test("backfills deterministic passive QQ reply sequences", async (context) => {
  const fixture = await schemaThreeFixture(context);
  const legacy = new Database(fixture.databasePath);
  legacy.prepare(
    `INSERT INTO logical_results (
       logical_result_id, profile_id, codex_thread_id, codex_turn_id,
       completed_at_ms, payload_digest, segment_count
     ) VALUES ('result-1', 'alpha', 'thread-1', 'turn-1', 1000, 'digest', 3)`
  ).run();
  const insert = legacy.prepare(
    `INSERT INTO delivery_outbox (
       outbox_record_id, logical_result_id, profile_id, segment_index, provider,
       channel_account_id, channel_account_epoch_id, conversation_key,
       conversation_kind, provider_conversation_id, provider_reply_event_id,
       text_body, status, next_attempt_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, 'result-1', 'alpha', ?, 'qq', 'qq-primary', 'epoch-1',
       'qq:qq-primary:private:user-1', 'private', 'user-1', 'event-1', ?,
       'pending', 1000, ?, ?)`
  );
  insert.run("outbox-1", 0, "one", 1000, 1000);
  insert.run("outbox-2", 1, "two", 1001, 1001);
  insert.run("outbox-3", 2, "three", 1002, 1002);
  legacy.close();

  const target = {
    profileId: "alpha",
    databasePath: fixture.databasePath,
    auditPath: join(fixture.directory, "audit.jsonl")
  };
  const plan = await planProfileStoreMigration(target);
  await applyProfileStoreMigration({
    ...target,
    expectedPlanDigest: plan.planDigest,
    expectedSourceDigest: plan.sourceDigest
  });

  const migrated = new Database(fixture.databasePath, { readonly: true });
  assert.deepEqual(
    migrated
      .prepare("SELECT provider_reply_sequence FROM delivery_outbox ORDER BY segment_index")
      .all()
      .map((row) => (row as { provider_reply_sequence: number }).provider_reply_sequence),
    [1, 2, 3]
  );
  assert.equal(
    (migrated.prepare("SELECT next_sequence FROM delivery_reply_sequences").get() as {
      next_sequence: number;
    }).next_sequence,
    4
  );
  migrated.close();
});

test("rejects stale confirmation and unknown schemas without mutation", async (context) => {
  const fixture = await schemaThreeFixture(context);
  const target = {
    profileId: "alpha",
    databasePath: fixture.databasePath,
    auditPath: join(fixture.directory, "audit.jsonl")
  };
  const plan = await planProfileStoreMigration(target);
  await assert.rejects(
    applyProfileStoreMigration({
      ...target,
      expectedPlanDigest: "wrong",
      expectedSourceDigest: plan.sourceDigest
    }),
    (error: unknown) => error instanceof ProfileMigrationError && error.reason === "source_changed"
  );
  const database = new Database(fixture.databasePath);
  assert.equal(database.pragma("user_version", { simple: true }), 3);
  database.pragma("user_version = 2");
  database.close();
  await assert.rejects(
    planProfileStoreMigration(target),
    (error: unknown) =>
      error instanceof ProfileMigrationError && error.reason === "unsupported_schema"
  );
});

async function schemaThreeFixture(context: test.TestContext): Promise<{
  directory: string;
  databasePath: string;
}> {
  const { directory, databasePath } = await currentFixture(context);
  const database = new Database(databasePath);
  downgradeFiveToFour(database);
  database.exec("DROP TABLE delivery_reply_sequences");
  database.exec("ALTER TABLE delivery_outbox DROP COLUMN provider_reply_sequence");
  database.pragma("user_version = 3");
  database.close();
  await chmod(databasePath, 0o600);
  return { directory, databasePath };
}

async function schemaFourFixture(context: test.TestContext): Promise<{
  directory: string;
  databasePath: string;
}> {
  const fixture = await currentFixture(context);
  const database = new Database(fixture.databasePath);
  downgradeFiveToFour(database);
  database.close();
  await chmod(fixture.databasePath, 0o600);
  return fixture;
}

async function schemaSixFixture(context: test.TestContext): Promise<{
  directory: string;
  databasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-migration-test-"));
  await chmod(directory, 0o700);
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "bridge.sqlite");
  SqliteProfileStore.open({ profileId: "alpha", databasePath }).close();
  const database = new Database(databasePath);
  downgradeEightToSeven(database);
  database.exec("DROP TABLE channel_transport_checkpoints");
  database.pragma("user_version = 6");
  database.close();
  return { directory, databasePath };
}

async function schemaSevenFixture(context: test.TestContext): Promise<{
  directory: string;
  databasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-migration-test-"));
  await chmod(directory, 0o700);
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "bridge.sqlite");
  SqliteProfileStore.open({ profileId: "alpha", databasePath }).close();
  const database = new Database(databasePath);
  downgradeEightToSeven(database);
  database.close();
  return { directory, databasePath };
}

async function currentFixture(context: test.TestContext): Promise<{
  directory: string;
  databasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-migration-test-"));
  await chmod(directory, 0o700);
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "bridge.sqlite");
  SqliteProfileStore.open({ profileId: "alpha", databasePath }).close();
  const database = new Database(databasePath);
  downgradeEightToSeven(database);
  downgradeSixToFive(database);
  database.close();
  return { directory, databasePath };
}

function downgradeEightToSeven(database: Database.Database): void {
  database.exec("DROP TABLE archive_attachments");
  database.pragma("user_version = 8");
  database.exec("ALTER TABLE delivery_outbox DROP COLUMN provider_reply_text_body");
  database.exec("ALTER TABLE delivery_outbox DROP COLUMN provider_reply_participant_id");
  database.pragma("user_version = 7");
}

function downgradeSixToFive(database: Database.Database): void {
  database.pragma("foreign_keys = OFF");
  database.exec(`
    DROP TABLE channel_transport_checkpoints;
    DROP TABLE audit_records;
    DROP TABLE approval_requests;

    CREATE TABLE logical_results_v5 (
      row_id INTEGER PRIMARY KEY,
      logical_result_id TEXT NOT NULL UNIQUE,
      profile_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (
        source_kind IN ('codex_turn', 'codex_input_uncertainty')
      ),
      source_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      codex_turn_id TEXT,
      completed_at_ms INTEGER NOT NULL,
      payload_digest TEXT NOT NULL,
      segment_count INTEGER NOT NULL CHECK (segment_count > 0),
      CHECK (source_kind <> 'codex_turn' OR codex_turn_id IS NOT NULL),
      UNIQUE (profile_id, source_kind, source_id)
    );
    INSERT INTO logical_results_v5 SELECT * FROM logical_results;

    CREATE TABLE delivery_outbox_v5 AS SELECT * FROM delivery_outbox WHERE 0;
    DROP TABLE delivery_outbox_v5;
    CREATE TABLE delivery_outbox_v5 (
      row_id INTEGER PRIMARY KEY,
      outbox_record_id TEXT NOT NULL UNIQUE,
      logical_result_id TEXT NOT NULL REFERENCES logical_results_v5(logical_result_id),
      profile_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
      provider TEXT NOT NULL CHECK (provider IN ('qq', 'whatsapp')),
      channel_account_id TEXT NOT NULL,
      channel_account_epoch_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('private', 'group')),
      provider_conversation_id TEXT NOT NULL,
      provider_reply_event_id TEXT,
      provider_reply_sequence INTEGER CHECK (provider_reply_sequence IS NULL OR provider_reply_sequence > 0),
      text_body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'retry_wait', 'accepted', 'rejected')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at_ms INTEGER NOT NULL,
      lease_token TEXT,
      lease_expires_at_ms INTEGER,
      last_outcome TEXT CHECK (last_outcome IN ('accepted', 'rejected', 'ambiguous', 'deferred')),
      last_reason_code TEXT,
      provider_message_id TEXT,
      accepted_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE (logical_result_id, segment_index)
    );
    INSERT INTO delivery_outbox_v5 SELECT * FROM delivery_outbox;
    DROP TABLE delivery_outbox;
    DROP TABLE logical_results;
    ALTER TABLE logical_results_v5 RENAME TO logical_results;
    ALTER TABLE delivery_outbox_v5 RENAME TO delivery_outbox;
    CREATE INDEX delivery_outbox_ready
      ON delivery_outbox (profile_id, status, next_attempt_at_ms, created_at_ms);
    PRAGMA user_version = 5;
  `);
  database.pragma("foreign_keys = ON");
}

function downgradeFiveToFour(database: Database.Database): void {
  database.pragma("foreign_keys = OFF");
  database.exec(`
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
      FROM logical_results
     WHERE source_kind = 'codex_turn';

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
