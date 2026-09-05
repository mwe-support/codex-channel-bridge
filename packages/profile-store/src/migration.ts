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
import { ANSWER_STREAM_SCHEMA } from "./answer-stream-schema.js";
import {
  assertWindowsOwnerOnlyPath,
  secureWindowsOwnerOnlyPath
} from "@codex-channel-bridge/platform";

const CURRENT_SCHEMA_VERSION = 11;
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

interface MigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly requireFrom: (database: Database.Database) => void;
  readonly migrate: (database: Database.Database) => void;
  readonly requireTo: (database: Database.Database) => void;
  readonly operations: readonly string[];
  readonly irreversibleSteps: readonly string[];
}

const MIGRATION_STEPS: readonly MigrationStep[] = [
  {
    fromVersion: 3,
    toVersion: 4,
    requireFrom: requireVersionThreeShape,
    migrate: migrateThreeToFour,
    requireTo: requireVersionFourShape,
    operations: [
      "add delivery_outbox.provider_reply_sequence",
      "backfill stable QQ passive reply sequences",
      "create delivery_reply_sequences",
      "set SQLite user_version to 4"
    ],
    irreversibleSteps: [
      "rebuild delivery_outbox to add provider reply sequencing for schema version 4"
    ]
  },
  {
    fromVersion: 4,
    toVersion: 5,
    requireFrom: requireVersionFourShape,
    migrate: migrateFourToFive,
    requireTo: requireVersionFiveShape,
    operations: versionFourToFiveOperations(),
    irreversibleSteps: versionFourToFiveIrreversibleSteps()
  },
  {
    fromVersion: 5,
    toVersion: 6,
    requireFrom: requireVersionFiveShape,
    migrate: migrateFiveToSix,
    requireTo: requireVersionSixShape,
    operations: versionFiveToSixOperations(),
    irreversibleSteps: versionFiveToSixIrreversibleSteps()
  },
  {
    fromVersion: 6,
    toVersion: 7,
    requireFrom: requireVersionSixShape,
    migrate: migrateSixToSeven,
    requireTo: requireVersionSevenShape,
    operations: versionSixToSevenOperations(),
    irreversibleSteps: versionSixToSevenIrreversibleSteps()
  },
  {
    fromVersion: 7,
    toVersion: 8,
    requireFrom: requireVersionSevenShape,
    migrate: migrateSevenToEight,
    requireTo: requireVersionEightShape,
    operations: versionSevenToEightOperations(),
    irreversibleSteps: versionSevenToEightIrreversibleSteps()
  },
  {
    fromVersion: 8,
    toVersion: 9,
    requireFrom: requireVersionEightShape,
    migrate: migrateEightToNine,
    requireTo: requireVersionNineShape,
    operations: versionEightToNineOperations(),
    irreversibleSteps: versionEightToNineIrreversibleSteps()
  },
  {
    fromVersion: 9,
    toVersion: 10,
    requireFrom: requireVersionNineShape,
    migrate: (database) => database.transaction(() => {
      database.exec(ANSWER_STREAM_SCHEMA);
      database.pragma("user_version = 10");
    }).immediate(),
    requireTo: requireVersionTenShape,
    operations: ["create native answer stream delivery metadata", "set SQLite user_version to 10"],
    irreversibleSteps: ["older Bridge binaries cannot read schema 10; rollback requires the prepared snapshot"]
  },
  {
    fromVersion: 10,
    toVersion: 11,
    requireFrom: requireVersionTenShape,
    migrate: (database) => database.transaction(() => {
      database.exec("ALTER TABLE delivery_outbox ADD COLUMN file_json TEXT CHECK(file_json IS NULL OR json_valid(file_json))");
      database.pragma("user_version = 11");
    }).immediate(),
    requireTo: requireVersionElevenShape,
    operations: ["add immutable output-file metadata to delivery outbox", "set SQLite user_version to 11"],
    irreversibleSteps: ["older Bridge binaries cannot read schema 11; rollback requires the prepared snapshot"]
  }
];

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
      requireVersionElevenShape(database);
      operations = [];
      irreversibleSteps = [];
    } else {
      const firstStep = MIGRATION_STEPS.find((step) => step.fromVersion === currentVersion);
      if (!firstStep) throw unsupportedSchema(currentVersion);
      firstStep.requireFrom(database);
      const steps = MIGRATION_STEPS.filter((step) => step.fromVersion >= currentVersion);
      operations = steps.flatMap((step) => step.operations);
      irreversibleSteps = steps.flatMap((step) => step.irreversibleSteps);
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
    fromVersion: plan.currentVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    atMs: nowMs
  });

  const database = new Database(options.databasePath, { timeout: 5_000, fileMustExist: true });
  let activeStep: { readonly fromVersion: number; readonly toVersion: number } | undefined;
  try {
    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    database.pragma("synchronous = FULL");
    requireProfile(database, options.profileId);
    let version = Number(database.pragma("user_version", { simple: true }));
    while (version < CURRENT_SCHEMA_VERSION) {
      const step = MIGRATION_STEPS.find((candidate) => candidate.fromVersion === version);
      if (!step) throw unsupportedSchema(version);
      step.requireFrom(database);
      activeStep = step;
      appendMigrationStepAudit(
        options.auditPath,
        correlationId,
        options.profileId,
        step.fromVersion,
        step.toVersion,
        "started"
      );
      step.migrate(database);
      step.requireTo(database);
      appendMigrationStepAudit(
        options.auditPath,
        correlationId,
        options.profileId,
        step.fromVersion,
        step.toVersion,
        "succeeded"
      );
      activeStep = undefined;
      version = step.toVersion;
    }
    requireVersionElevenShape(database);
    const quickCheck = String(database.pragma("quick_check", { simple: true }));
    if (quickCheck !== "ok") throw new Error("SQLite quick_check failed");
  } catch (error) {
    if (activeStep) {
      appendMigrationStepAudit(
        options.auditPath,
        correlationId,
        options.profileId,
        activeStep.fromVersion,
        activeStep.toVersion,
        "failed"
      );
    }
    appendAudit(options.auditPath, {
      correlationId,
      profileId: options.profileId,
      action: "profile_schema_migrate",
      result: "failed",
      fromVersion: plan.currentVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      atMs: Date.now()
    });
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new ProfileMigrationError("migration_failed", `Profile schema migration failed${detail}`);
  } finally {
    database.close();
  }

  appendAudit(options.auditPath, {
    correlationId,
    profileId: options.profileId,
    action: "profile_schema_migrate",
    result: "succeeded",
    fromVersion: plan.currentVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    atMs: Date.now()
  });
  return {
    profileId: options.profileId,
    fromVersion: plan.currentVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
    sourceDigest: plan.sourceDigest,
    planDigest: plan.planDigest,
    auditCorrelationId: correlationId
  };
}

function unsupportedSchema(version: number): ProfileMigrationError {
  return new ProfileMigrationError(
    "unsupported_schema",
    `Profile schema ${version} cannot be migrated by this binary`
  );
}

function appendMigrationStepAudit(
  auditPath: string,
  correlationId: string,
  profileId: string,
  fromVersion: number,
  toVersion: number,
  result: "started" | "succeeded" | "failed"
): void {
  appendAudit(auditPath, {
    correlationId,
    profileId,
    action: "profile_schema_migrate_step",
    result,
    fromVersion,
    toVersion,
    atMs: Date.now()
  });
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
    database.pragma("user_version = 4");
  });
  migrate.immediate();
}

function versionFourToFiveOperations(): readonly string[] {
  return [
    "persist message_archive.provider_conversation_id",
    "generalize Logical Result source identity",
    "rebuild delivery_outbox foreign-key edge",
    "set SQLite user_version to 5",
    "verify profile ownership, schema shape, foreign keys, and quick_check"
  ];
}

function versionFourToFiveIrreversibleSteps(): readonly string[] {
  return [
    "rebuild logical_results with generalized source identity",
    "rebuild delivery_outbox against the generalized Logical Result key"
  ];
}

function migrateFourToFive(database: Database.Database): void {
  database.pragma("foreign_keys = OFF");
  try {
    const migrate = database.transaction(() => {
      database.exec(`
        ALTER TABLE message_archive ADD COLUMN provider_conversation_id TEXT;

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

        INSERT INTO logical_results_v5 (
          row_id, logical_result_id, profile_id, source_kind, source_id,
          codex_thread_id, codex_turn_id, completed_at_ms, payload_digest, segment_count
        )
        SELECT row_id, logical_result_id, profile_id, 'codex_turn', codex_turn_id,
               codex_thread_id, codex_turn_id, completed_at_ms, payload_digest, segment_count
          FROM logical_results;

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

        INSERT INTO delivery_outbox_v5 (
          row_id, outbox_record_id, logical_result_id, profile_id, segment_index,
          provider, channel_account_id, channel_account_epoch_id, conversation_key,
          conversation_kind, provider_conversation_id, provider_reply_event_id,
          provider_reply_sequence, text_body, status, attempt_count, next_attempt_at_ms,
          lease_token, lease_expires_at_ms, last_outcome, last_reason_code,
          provider_message_id, accepted_at_ms, created_at_ms, updated_at_ms
        )
        SELECT row_id, outbox_record_id, logical_result_id, profile_id, segment_index,
               provider, channel_account_id, channel_account_epoch_id, conversation_key,
               conversation_kind, provider_conversation_id, provider_reply_event_id,
               provider_reply_sequence, text_body, status, attempt_count, next_attempt_at_ms,
               lease_token, lease_expires_at_ms, last_outcome, last_reason_code,
               provider_message_id, accepted_at_ms, created_at_ms, updated_at_ms
          FROM delivery_outbox;

        DROP TABLE delivery_outbox;
        DROP TABLE logical_results;
        ALTER TABLE logical_results_v5 RENAME TO logical_results;
        ALTER TABLE delivery_outbox_v5 RENAME TO delivery_outbox;

        CREATE INDEX delivery_outbox_ready
          ON delivery_outbox (profile_id, status, next_attempt_at_ms, created_at_ms);
      `);
      const archiveRows = database
        .prepare<[], { readonly record_id: string; readonly conversation_key: string }>(
          "SELECT record_id, conversation_key FROM message_archive"
        )
        .all();
      const updateArchive = database.prepare(
        "UPDATE message_archive SET provider_conversation_id = ? WHERE record_id = ?"
      );
      for (const row of archiveRows) {
        updateArchive.run(providerConversationIdFromKey(row.conversation_key), row.record_id);
      }
      database.pragma("user_version = 5");
      const violations = database.pragma("foreign_key_check") as readonly unknown[];
      if (violations.length > 0) throw new Error("SQLite foreign_key_check failed");
    });
    migrate.immediate();
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

function providerConversationIdFromKey(conversationKey: string): string {
  const encoded = conversationKey.split(":").at(-1);
  if (!encoded) throw new Error("Conversation Key has no provider target");
  const decoded = decodeURIComponent(encoded);
  if (!decoded) throw new Error("Conversation Key provider target is empty");
  return decoded;
}

function versionFiveToSixOperations(): readonly string[] {
  return [
    "generalize Logical Result source identity for Approval Requests",
    "create durable approval_requests",
    "create body-free audit_records",
    "set SQLite user_version to 6",
    "verify profile ownership, schema shape, foreign keys, and quick_check"
  ];
}

function versionFiveToSixIrreversibleSteps(): readonly string[] {
  return [
    "rebuild logical_results for Approval Request source identity",
    "rebuild delivery_outbox against schema version 6 Logical Results",
    "create durable Approval and Audit state"
  ];
}

function versionSixToSevenOperations(): readonly string[] {
  return [
    "create durable Channel transport checkpoints",
    "set SQLite user_version to 7",
    "verify profile ownership, schema shape, foreign keys, and quick_check"
  ];
}

function versionSixToSevenIrreversibleSteps(): readonly string[] {
  return ["create durable Channel transport checkpoint state"];
}

function versionSevenToEightOperations(): readonly string[] {
  return [
    "add durable WhatsApp quoted-reply participant and text fields",
    "set SQLite user_version to 8",
    "verify profile ownership, schema shape, foreign keys, and quick_check"
  ];
}

function versionSevenToEightIrreversibleSteps(): readonly string[] {
  return ["extend delivery Outbox records with WhatsApp quoted-reply facts"];
}

function versionEightToNineOperations(): readonly string[] {
  return [
    "create durable Archive attachment metadata and media state",
    "set SQLite user_version to 9",
    "verify profile ownership, schema shape, foreign keys, and quick_check"
  ];
}

function versionEightToNineIrreversibleSteps(): readonly string[] {
  return ["create durable Archive attachment and media state"];
}

function migrateSixToSeven(database: Database.Database): void {
  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE channel_transport_checkpoints (
        row_id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL,
        channel_account_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('qq', 'whatsapp')),
        session_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (profile_id, channel_account_id)
      );
    `);
    database.pragma("user_version = 7");
  });
  migrate.immediate();
}

function migrateSevenToEight(database: Database.Database): void {
  const migrate = database.transaction(() => {
    database.exec(`
      ALTER TABLE delivery_outbox ADD COLUMN provider_reply_participant_id TEXT;
      ALTER TABLE delivery_outbox ADD COLUMN provider_reply_text_body TEXT;
    `);
    database.pragma("user_version = 8");
  });
  migrate.immediate();
}

function migrateEightToNine(database: Database.Database): void {
  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE archive_attachments (
        row_id INTEGER PRIMARY KEY,
        attachment_record_id TEXT NOT NULL UNIQUE,
        message_record_id TEXT NOT NULL REFERENCES message_archive(record_id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        provider_attachment_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        original_filename TEXT,
        source_url TEXT,
        declared_size_bytes INTEGER CHECK (declared_size_bytes IS NULL OR declared_size_bytes >= 0),
        width INTEGER CHECK (width IS NULL OR width >= 0),
        height INTEGER CHECK (height IS NULL OR height >= 0),
        transcript TEXT,
        bytes_state TEXT NOT NULL CHECK (
          bytes_state IN ('metadata_only', 'pending', 'mirrored', 'unavailable')
        ),
        content_sha256 TEXT,
        mirrored_size_bytes INTEGER CHECK (
          mirrored_size_bytes IS NULL OR mirrored_size_bytes >= 0
        ),
        failure_reason TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (message_record_id, provider_attachment_id),
        CHECK (bytes_state <> 'mirrored' OR (
          content_sha256 IS NOT NULL AND mirrored_size_bytes IS NOT NULL
        )),
        CHECK (bytes_state <> 'unavailable' OR failure_reason IS NOT NULL)
      );
      CREATE INDEX archive_attachments_state
        ON archive_attachments (profile_id, bytes_state, created_at_ms);
      CREATE INDEX archive_attachments_content
        ON archive_attachments (profile_id, content_sha256)
        WHERE content_sha256 IS NOT NULL;
    `);
    database.pragma("user_version = 9");
  });
  migrate.immediate();
}

function migrateFiveToSix(database: Database.Database): void {
  database.pragma("foreign_keys = OFF");
  try {
    const migrate = database.transaction(() => {
      database.exec(`
        CREATE TABLE logical_results_v6 (
          row_id INTEGER PRIMARY KEY,
          logical_result_id TEXT NOT NULL UNIQUE,
          profile_id TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (
            source_kind IN ('codex_turn', 'codex_input_uncertainty', 'approval_request')
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

        INSERT INTO logical_results_v6
        SELECT * FROM logical_results;

        CREATE TABLE delivery_outbox_v6 (
          row_id INTEGER PRIMARY KEY,
          outbox_record_id TEXT NOT NULL UNIQUE,
          logical_result_id TEXT NOT NULL REFERENCES logical_results_v6(logical_result_id),
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

        INSERT INTO delivery_outbox_v6
        SELECT * FROM delivery_outbox;

        DROP TABLE delivery_outbox;
        DROP TABLE logical_results;
        ALTER TABLE logical_results_v6 RENAME TO logical_results;
        ALTER TABLE delivery_outbox_v6 RENAME TO delivery_outbox;

        CREATE INDEX delivery_outbox_ready
          ON delivery_outbox (profile_id, status, next_attempt_at_ms, created_at_ms);

        CREATE TABLE approval_requests (
          row_id INTEGER PRIMARY KEY,
          approval_token TEXT NOT NULL UNIQUE,
          profile_id TEXT NOT NULL,
          operation_kind TEXT NOT NULL CHECK (
            operation_kind IN ('command_execution', 'file_change')
          ),
          codex_thread_id TEXT NOT NULL,
          codex_turn_id TEXT NOT NULL,
          channel_account_id TEXT NOT NULL,
          channel_account_epoch_id TEXT NOT NULL,
          conversation_key TEXT NOT NULL,
          provider_identity TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('pending', 'responded', 'cancelled', 'expired', 'failed')
          ),
          presentation_state TEXT NOT NULL CHECK (
            presentation_state IN ('pending', 'accepted', 'ambiguous', 'rejected')
          ),
          decision TEXT CHECK (
            decision IN ('accept', 'acceptForSession', 'decline', 'cancel')
          ),
          reason_code TEXT,
          created_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          settled_at_ms INTEGER,
          CHECK (expires_at_ms > created_at_ms),
          CHECK (state = 'pending' OR settled_at_ms IS NOT NULL),
          CHECK (state <> 'responded' OR decision IS NOT NULL)
        );

        CREATE INDEX approval_requests_pending
          ON approval_requests (profile_id, state, expires_at_ms);

        CREATE TABLE audit_records (
          row_id INTEGER PRIMARY KEY,
          audit_record_id TEXT NOT NULL UNIQUE,
          profile_id TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          action TEXT NOT NULL,
          result TEXT NOT NULL,
          target_reference TEXT NOT NULL,
          at_ms INTEGER NOT NULL
        );

        CREATE INDEX audit_records_profile_time
          ON audit_records (profile_id, at_ms DESC, row_id DESC);
      `);
      database.pragma("user_version = 6");
      const violations = database.pragma("foreign_key_check") as readonly unknown[];
      if (violations.length > 0) throw new Error("SQLite foreign_key_check failed");
    });
    migrate.immediate();
  } finally {
    database.pragma("foreign_keys = ON");
  }
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
  try {
    assertWindowsOwnerOnlyPath(dirname(databasePath), "directory");
    assertWindowsOwnerOnlyPath(databasePath, "file");
  } catch {
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
    Number(database.pragma("user_version", { simple: true })) !== 3 ||
    tableColumns(database, "delivery_outbox").includes("provider_reply_sequence") ||
    tableExists(database, "delivery_reply_sequences") ||
    tableColumns(database, "message_archive").includes("provider_conversation_id") ||
    tableColumns(database, "logical_results").includes("source_kind")
  ) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 3 shape is inconsistent");
  }
}

function requireVersionFourShape(database: Database.Database): void {
  const version = Number(database.pragma("user_version", { simple: true }));
  if (
    version !== 4 ||
    !tableColumns(database, "delivery_outbox").includes("provider_reply_sequence") ||
    !tableExists(database, "delivery_reply_sequences") ||
    tableColumns(database, "message_archive").includes("provider_conversation_id") ||
    tableColumns(database, "logical_results").includes("source_kind")
  ) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 4 shape is inconsistent");
  }
}

function requireVersionFiveShape(database: Database.Database): void {
  const version = Number(database.pragma("user_version", { simple: true }));
  const logicalColumns = tableColumns(database, "logical_results");
  if (
    version !== 5 ||
    !tableColumns(database, "delivery_outbox").includes("provider_reply_sequence") ||
    !tableExists(database, "delivery_reply_sequences") ||
    !tableColumns(database, "message_archive").includes("provider_conversation_id") ||
    !logicalColumns.includes("source_kind") ||
    !logicalColumns.includes("source_id")
  ) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 5 shape is inconsistent");
  }
}

function requireVersionSixShape(database: Database.Database): void {
  const version = Number(database.pragma("user_version", { simple: true }));
  const logicalColumns = tableColumns(database, "logical_results");
  if (
    version !== 6 ||
    !tableColumns(database, "delivery_outbox").includes("provider_reply_sequence") ||
    !tableExists(database, "delivery_reply_sequences") ||
    !tableColumns(database, "message_archive").includes("provider_conversation_id") ||
    !logicalColumns.includes("source_kind") ||
    !logicalColumns.includes("source_id") ||
    !tableExists(database, "approval_requests") ||
    !tableExists(database, "audit_records")
  ) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 6 shape is inconsistent");
  }
}

function requireVersionSevenShape(database: Database.Database): void {
  requireVersionSixCompatibleShape(database, 7);
  const checkpointColumns = tableColumns(database, "channel_transport_checkpoints");
  if (
    !checkpointColumns.includes("profile_id") ||
    !checkpointColumns.includes("channel_account_id") ||
    !checkpointColumns.includes("provider") ||
    !checkpointColumns.includes("session_id") ||
    !checkpointColumns.includes("sequence_number") ||
    !checkpointColumns.includes("updated_at_ms")
  ) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 7 shape is inconsistent");
  }
}

function requireVersionEightShape(database: Database.Database): void {
  requireVersionSixCompatibleShape(database, 8);
  const checkpointColumns = tableColumns(database, "channel_transport_checkpoints");
  const outboxColumns = tableColumns(database, "delivery_outbox");
  if (
    !checkpointColumns.includes("profile_id") ||
    !checkpointColumns.includes("channel_account_id") ||
    !checkpointColumns.includes("provider") ||
    !checkpointColumns.includes("session_id") ||
    !checkpointColumns.includes("sequence_number") ||
    !checkpointColumns.includes("updated_at_ms") ||
    !outboxColumns.includes("provider_reply_participant_id") ||
    !outboxColumns.includes("provider_reply_text_body")
  ) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 8 shape is inconsistent");
  }
}

function requireVersionNineShape(database: Database.Database, version = 9): void {
  requireVersionSixCompatibleShape(database, version);
  const checkpointColumns = tableColumns(database, "channel_transport_checkpoints");
  const outboxColumns = tableColumns(database, "delivery_outbox");
  const attachmentColumns = tableColumns(database, "archive_attachments");
  if (
    !checkpointColumns.includes("sequence_number") ||
    !outboxColumns.includes("provider_reply_participant_id") ||
    !outboxColumns.includes("provider_reply_text_body") ||
    !attachmentColumns.includes("attachment_record_id") ||
    !attachmentColumns.includes("message_record_id") ||
    !attachmentColumns.includes("bytes_state") ||
    !attachmentColumns.includes("content_sha256") ||
    !attachmentColumns.includes("mirrored_size_bytes")
  ) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 9 shape is inconsistent");
  }
}

function requireVersionTenShape(database: Database.Database, version = 10): void {
  requireVersionNineShape(database, version);
  const columns = tableColumns(database, "answer_streams");
  if (!columns.includes("state_json") || !columns.includes("archive_record_id")) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 10 shape is inconsistent");
  }
}

function requireVersionElevenShape(database: Database.Database): void {
  requireVersionTenShape(database, 11);
  if (!tableColumns(database, "delivery_outbox").includes("file_json")) {
    throw new ProfileMigrationError("schema_mismatch", "Schema version 11 shape is inconsistent");
  }
}

function requireVersionSixCompatibleShape(database: Database.Database, version: number): void {
  const logicalColumns = tableColumns(database, "logical_results");
  if (
    Number(database.pragma("user_version", { simple: true })) !== version ||
    !tableColumns(database, "delivery_outbox").includes("provider_reply_sequence") ||
    !tableExists(database, "delivery_reply_sequences") ||
    !tableColumns(database, "message_archive").includes("provider_conversation_id") ||
    !logicalColumns.includes("source_kind") ||
    !logicalColumns.includes("source_id") ||
    !tableExists(database, "approval_requests") ||
    !tableExists(database, "audit_records")
  ) {
    throw new ProfileMigrationError("schema_mismatch", `Schema version ${version} shape is inconsistent`);
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
    try { assertWindowsOwnerOnlyPath(path, "file"); } catch {
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
      assertWindowsOwnerOnlyPath(auditPath, "file");
    }
    const descriptor = openSync(auditPath, "a", 0o600);
    try {
      secureWindowsOwnerOnlyPath(auditPath, "file");
      appendFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    throw new ProfileMigrationError("audit_failed", "Migration Audit Record could not be persisted");
  }
}
