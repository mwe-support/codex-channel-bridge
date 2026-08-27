import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import Database from "better-sqlite3";

const CURRENT_SCHEMA_VERSION = 4;
const MIN_ESTIMATED_ADDITIONAL_BYTES = 1024 * 1024;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export type ProfileMigrationReason =
  | "invalid_migration_configuration"
  | "insecure_store_path"
  | "unsupported_schema"
  | "schema_mismatch"
  | "profile_mismatch"
  | "source_changed"
  | "migration_failed"
  | "audit_failed";

export class ProfileMigrationError extends Error {
  public constructor(
    public readonly reason: ProfileMigrationReason,
    message: string
  ) {
    super(message);
    this.name = "ProfileMigrationError";
  }
}

export interface ProfileMigrationTarget {
  readonly profileId: string;
  readonly databasePath: string;
  readonly auditPath: string;
}

export interface ProfileMigrationPlan {
  readonly profileId: string;
  readonly currentVersion: number;
  readonly targetVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly migrationRequired: boolean;
  readonly sourceDigest: string;
  readonly planDigest: string;
  readonly sourceBytes: number;
  readonly estimatedAdditionalBytes: number;
  readonly operations: readonly string[];
  readonly irreversibleSteps: readonly string[];
}

export interface ApplyProfileMigrationOptions extends ProfileMigrationTarget {
  readonly expectedPlanDigest: string;
  readonly expectedSourceDigest: string;
  readonly nowMs?: number;
}

export interface ProfileMigrationResult {
  readonly profileId: string;
  readonly fromVersion: number;
  readonly toVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly sourceDigest: string;
  readonly planDigest: string;
  readonly auditCorrelationId: string;
}

export async function planProfileStoreMigration(
  target: ProfileMigrationTarget
): Promise<ProfileMigrationPlan> {
  validateTarget(target);
  assertOwnerOnlyStore(target.databasePath);
  const sourceBefore = await digestSqliteSet(target.databasePath);
  const inspection = copySqliteSetForInspection(target.databasePath);
  let database: Database.Database | undefined;
  let currentVersion: number;
  let operations: readonly string[];
  let irreversibleSteps: readonly string[];
  try {
    database = openReadonly(inspection.databasePath);
    currentVersion = Number(database.pragma("user_version", { simple: true }));
    requireProfile(database, target.profileId);
    if (currentVersion === CURRENT_SCHEMA_VERSION) {
      requireVersionFourShape(database);
      operations = [];
      irreversibleSteps = [];
    } else if (currentVersion === 3) {
      requireVersionThreeShape(database);
      operations = [
        "add delivery_outbox.provider_reply_sequence",
        "backfill stable QQ passive reply sequences",
        "create delivery_reply_sequences",
        "set SQLite user_version to 4",
        "verify profile ownership, schema shape, and quick_check"
      ];
      irreversibleSteps = ["upgrade the Profile SQLite schema from version 3 to version 4"];
    } else {
      throw new ProfileMigrationError(
        "unsupported_schema",
        `Profile schema ${currentVersion} cannot be migrated by this binary`
      );
    }
  } finally {
    database?.close();
    rmSync(inspection.directory, { recursive: true, force: true });
  }
  const source = await digestSqliteSet(target.databasePath);
  if (source.digest !== sourceBefore.digest || source.bytes !== sourceBefore.bytes) {
    throw new ProfileMigrationError("source_changed", "Profile store changed while planning");
  }
  return buildPlan(
    target.profileId,
    currentVersion,
    source.digest,
    source.bytes,
    operations,
    irreversibleSteps
  );
}

function copySqliteSetForInspection(databasePath: string): {
  readonly directory: string;
  readonly databasePath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "bridge-migration-plan-"));
  const copyPath = join(directory, "bridge.sqlite");
  try {
    copyFileSync(databasePath, copyPath);
    if (existsSync(`${databasePath}-wal`)) {
      copyFileSync(`${databasePath}-wal`, `${copyPath}-wal`);
    }
    return { directory, databasePath: copyPath };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function applyProfileStoreMigration(
  options: ApplyProfileMigrationOptions
): Promise<ProfileMigrationResult> {
  const plan = await planProfileStoreMigration(options);
  if (!plan.migrationRequired) {
    throw new ProfileMigrationError("unsupported_schema", "Profile store is already current");
  }
  if (plan.planDigest !== options.expectedPlanDigest) {
    throw new ProfileMigrationError("source_changed", "Migration plan changed before apply");
  }
  if (plan.sourceDigest !== options.expectedSourceDigest) {
    throw new ProfileMigrationError("source_changed", "Profile store changed before apply");
  }

  const correlationId = randomUUID();
  const nowMs = options.nowMs ?? Date.now();
  appendAudit(options.auditPath, {
    correlationId,
    profileId: options.profileId,
    action: "profile_schema_migrate",
    result: "started",
    fromVersion: 3,
    toVersion: CURRENT_SCHEMA_VERSION,
    atMs: nowMs
  });

  const database = new Database(options.databasePath, { timeout: 5_000, fileMustExist: true });
  try {
    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    database.pragma("synchronous = FULL");
    requireProfile(database, options.profileId);
    requireVersionThreeShape(database);
    migrateThreeToFour(database);
    requireVersionFourShape(database);
    const quickCheck = String(database.pragma("quick_check", { simple: true }));
    if (quickCheck !== "ok") throw new Error("SQLite quick_check failed");
  } catch {
    appendAudit(options.auditPath, {
      correlationId,
      profileId: options.profileId,
      action: "profile_schema_migrate",
      result: "failed",
      fromVersion: 3,
      toVersion: CURRENT_SCHEMA_VERSION,
      atMs: Date.now()
    });
    throw new ProfileMigrationError("migration_failed", "Profile schema migration failed");
  } finally {
    database.close();
  }

  appendAudit(options.auditPath, {
    correlationId,
    profileId: options.profileId,
    action: "profile_schema_migrate",
    result: "succeeded",
    fromVersion: 3,
    toVersion: CURRENT_SCHEMA_VERSION,
    atMs: Date.now()
  });
  return {
    profileId: options.profileId,
    fromVersion: 3,
    toVersion: CURRENT_SCHEMA_VERSION,
    sourceDigest: plan.sourceDigest,
    planDigest: plan.planDigest,
    auditCorrelationId: correlationId
  };
}

function migrateThreeToFour(database: Database.Database): void {
  const migrate = database.transaction(() => {
    database.exec(`
      ALTER TABLE delivery_outbox
        ADD COLUMN provider_reply_sequence INTEGER CHECK (
          provider_reply_sequence IS NULL OR provider_reply_sequence > 0
        );

      CREATE TABLE delivery_reply_sequences (
        row_id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider = 'qq'),
        channel_account_id TEXT NOT NULL,
        channel_account_epoch_id TEXT NOT NULL,
        provider_reply_event_id TEXT NOT NULL,
        next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
        UNIQUE (
          profile_id,
          provider,
          channel_account_id,
          channel_account_epoch_id,
          provider_reply_event_id
        )
      );
    `);
    const rows = database
      .prepare<[], LegacyPassiveReplyRow>(
        `SELECT row_id,
                profile_id,
                channel_account_id,
                channel_account_epoch_id,
                provider_reply_event_id
           FROM delivery_outbox
          WHERE provider = 'qq'
            AND provider_reply_event_id IS NOT NULL
          ORDER BY profile_id,
                   channel_account_id,
                   channel_account_epoch_id,
                   provider_reply_event_id,
                   created_at_ms,
                   row_id`
      )
      .all();
    const update = database.prepare(
      "UPDATE delivery_outbox SET provider_reply_sequence = ? WHERE row_id = ?"
    );
    const nextByAnchor = new Map<string, { readonly row: LegacyPassiveReplyRow; next: number }>();
    for (const row of rows) {
      const key = [
        row.profile_id,
        row.channel_account_id,
        row.channel_account_epoch_id,
        row.provider_reply_event_id
      ].join("\u0000");
      const entry = nextByAnchor.get(key) ?? { row, next: 1 };
      update.run(entry.next, row.row_id);
      entry.next += 1;
      nextByAnchor.set(key, entry);
    }
    const insertNext = database.prepare(
      `INSERT INTO delivery_reply_sequences (
         profile_id,
         provider,
         channel_account_id,
         channel_account_epoch_id,
         provider_reply_event_id,
         next_sequence
       ) VALUES (?, 'qq', ?, ?, ?, ?)`
    );
    for (const entry of nextByAnchor.values()) {
      insertNext.run(
        entry.row.profile_id,
        entry.row.channel_account_id,
        entry.row.channel_account_epoch_id,
        entry.row.provider_reply_event_id,
        entry.next
      );
    }
    database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  migrate.immediate();
}

interface LegacyPassiveReplyRow {
  readonly row_id: number;
  readonly profile_id: string;
  readonly channel_account_id: string;
  readonly channel_account_epoch_id: string;
  readonly provider_reply_event_id: string;
}

function buildPlan(
  profileId: string,
  currentVersion: number,
  sourceDigest: string,
  sourceBytes: number,
  operations: readonly string[],
  irreversibleSteps: readonly string[]
): ProfileMigrationPlan {
  const structural = {
    profileId,
    currentVersion,
    targetVersion: CURRENT_SCHEMA_VERSION as typeof CURRENT_SCHEMA_VERSION,
    sourceDigest,
    sourceBytes,
    operations,
    irreversibleSteps
  };
  return {
    ...structural,
    migrationRequired: currentVersion !== CURRENT_SCHEMA_VERSION,
    estimatedAdditionalBytes: Math.max(sourceBytes, MIN_ESTIMATED_ADDITIONAL_BYTES),
    planDigest: createHash("sha256").update(JSON.stringify(structural)).digest("hex")
  };
}

function validateTarget(target: ProfileMigrationTarget): void {
  if (
    !PROFILE_ID_PATTERN.test(target.profileId) ||
    !isAbsolute(target.databasePath) ||
    !isAbsolute(target.auditPath) ||
    dirname(target.databasePath) !== dirname(target.auditPath)
  ) {
    throw new ProfileMigrationError(
      "invalid_migration_configuration",
      "Profile migration target is invalid"
    );
  }
}

function assertOwnerOnlyStore(databasePath: string): void {
  const parent = lstatSync(dirname(databasePath));
  const file = lstatSync(databasePath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !file.isFile() || file.isSymbolicLink()) {
    throw new ProfileMigrationError("insecure_store_path", "Profile store path is insecure");
  }
  if (
    process.platform !== "win32" &&
    (parent.uid !== process.getuid?.() ||
      (parent.mode & 0o777) !== 0o700 ||
      file.uid !== process.getuid?.() ||
      (file.mode & 0o777) !== 0o600)
  ) {
    throw new ProfileMigrationError("insecure_store_path", "Profile store is not owner-only");
  }
}

function openReadonly(databasePath: string): Database.Database {
  try {
    return new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch {
    throw new ProfileMigrationError("schema_mismatch", "Profile store could not be inspected");
  }
}

function requireProfile(database: Database.Database, profileId: string): void {
  const metadata = database
    .prepare<[], { profile_id: string }>(
      "SELECT profile_id FROM profile_metadata WHERE singleton = 1"
    )
    .get();
  if (!metadata) throw new ProfileMigrationError("schema_mismatch", "Profile metadata is missing");
  if (metadata.profile_id !== profileId) {
    throw new ProfileMigrationError("profile_mismatch", "Profile store belongs to another Profile");
  }
}

function requireVersionThreeShape(database: Database.Database): void {
  if (
    tableColumns(database, "delivery_outbox").includes("provider_reply_sequence") ||
    tableExists(database, "delivery_reply_sequences")
  ) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 3 shape is inconsistent");
  }
}

function requireVersionFourShape(database: Database.Database): void {
  const version = Number(database.pragma("user_version", { simple: true }));
  if (
    version !== CURRENT_SCHEMA_VERSION ||
    !tableColumns(database, "delivery_outbox").includes("provider_reply_sequence") ||
    !tableExists(database, "delivery_reply_sequences")
  ) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 4 shape is inconsistent");
  }
}

function tableColumns(database: Database.Database, table: string): readonly string[] {
  return database
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(
    database
      .prepare<{ table: string }, { count: number }>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = @table"
      )
      .get({ table })?.count
  );
}

async function digestSqliteSet(databasePath: string): Promise<{ digest: string; bytes: number }> {
  const paths = [databasePath, `${databasePath}-wal`].filter((path) => existsSync(path));
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of paths) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ProfileMigrationError("insecure_store_path", "SQLite set is invalid");
    }
    if (
      process.platform !== "win32" &&
      (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    ) {
      throw new ProfileMigrationError("insecure_store_path", "SQLite set is not owner-only");
    }
    bytes += stat.size;
    hash.update(path === databasePath ? "database\0" : "wal\0");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  }
  return { digest: hash.digest("hex"), bytes };
}

function appendAudit(auditPath: string, record: Record<string, unknown>): void {
  try {
    if (existsSync(auditPath)) {
      const file = lstatSync(auditPath);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error("invalid audit path");
      if (
        process.platform !== "win32" &&
        (file.uid !== process.getuid?.() || (file.mode & 0o777) !== 0o600)
      ) {
        throw new Error("insecure audit file");
      }
    }
    const descriptor = openSync(auditPath, "a", 0o600);
    try {
      appendFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    throw new ProfileMigrationError("audit_failed", "Migration Audit Record could not be persisted");
  }
}
