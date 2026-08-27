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

test("plans and applies the explicit schema 3 to 4 migration", async (context) => {
  const fixture = await schemaThreeFixture(context);
  const target = {
    profileId: "alpha",
    databasePath: fixture.databasePath,
    auditPath: join(fixture.directory, "audit.jsonl")
  };

  const plan = await planProfileStoreMigration(target);
  assert.equal(plan.currentVersion, 3);
  assert.equal(plan.targetVersion, 4);
  assert.equal(plan.migrationRequired, true);
  assert.equal(plan.operations.length, 5);
  assert.equal(plan.irreversibleSteps.length, 1);
  assert.ok(plan.estimatedAdditionalBytes >= 1024 * 1024);

  const result = await applyProfileStoreMigration({
    ...target,
    expectedPlanDigest: plan.planDigest,
    expectedSourceDigest: plan.sourceDigest,
    nowMs: 10_000
  });
  assert.equal(result.fromVersion, 3);
  assert.equal(result.toVersion, 4);
  SqliteProfileStore.open({ profileId: "alpha", databasePath: fixture.databasePath }).close();
  const current = await planProfileStoreMigration(target);
  assert.equal(current.migrationRequired, false);
  const audit = (await readFile(target.auditPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { result: string });
  assert.deepEqual(audit.map((record) => record.result), ["started", "succeeded"]);
  assert.equal((await stat(target.auditPath)).mode & 0o777, 0o600);
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
  const directory = await mkdtemp(join(tmpdir(), "bridge-migration-test-"));
  await chmod(directory, 0o700);
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "bridge.sqlite");
  SqliteProfileStore.open({ profileId: "alpha", databasePath }).close();
  const database = new Database(databasePath);
  database.exec("DROP TABLE delivery_reply_sequences");
  database.exec("ALTER TABLE delivery_outbox DROP COLUMN provider_reply_sequence");
  database.pragma("user_version = 3");
  database.close();
  await chmod(databasePath, 0o600);
  return { directory, databasePath };
}
