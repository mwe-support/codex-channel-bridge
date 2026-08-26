import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import Database from "better-sqlite3";

import type {
  ChannelConversationKind,
  ChannelProvider,
  NormalizedChannelMessage
} from "@codex-channel-bridge/core";

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const SCHEMA_VERSION = 1;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_EXTERNAL_ID_BYTES = 8 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export type ProfileStoreReason =
  | "invalid_store_configuration"
  | "insecure_store_path"
  | "fts5_unavailable"
  | "migration_required"
  | "profile_mismatch"
  | "invalid_channel_message"
  | "storage_failure";

export class ProfileStoreError extends Error {
  public constructor(
    public readonly reason: ProfileStoreReason,
    message: string
  ) {
    super(message);
    this.name = "ProfileStoreError";
  }
}

export interface OpenProfileStoreOptions {
  readonly profileId: string;
  readonly databasePath: string;
  readonly busyTimeoutMs?: number;
}

export interface ArchiveCommitResult {
  readonly recordId: string;
  readonly inserted: boolean;
}

export interface ArchivedChannelMessage extends NormalizedChannelMessage {
  readonly recordId: string;
}

export interface ArchiveTextSearch {
  readonly text: string;
  readonly conversationKey?: string;
  readonly limit?: number;
}

export interface ArchiveTextSearchHit extends ArchivedChannelMessage {
  /** Lower values rank first, following SQLite FTS5 bm25(). */
  readonly rank: number;
}

interface ArchiveRow {
  readonly record_id: string;
  readonly profile_id: string;
  readonly provider: ChannelProvider;
  readonly channel_account_id: string;
  readonly channel_account_epoch_id: string;
  readonly provider_event_id: string;
  readonly conversation_key: string;
  readonly conversation_kind: ChannelConversationKind;
  readonly provider_identity: string;
  readonly observed_at_ms: number;
  readonly text_body: string | null;
}

interface ArchiveSearchRow extends ArchiveRow {
  readonly rank: number;
}

export class SqliteProfileStore {
  readonly #profileId: string;
  readonly #database: Database.Database;
  #closed = false;

  private constructor(profileId: string, database: Database.Database) {
    this.#profileId = profileId;
    this.#database = database;
  }

  public static open(options: OpenProfileStoreOptions): SqliteProfileStore {
    validateOpenOptions(options);
    const existed = fileExists(options.databasePath);
    assertStorePath(options.databasePath, existed);

    let database: Database.Database | undefined;
    try {
      database = new Database(options.databasePath, {
        timeout: options.busyTimeoutMs ?? 5_000
      });
      if (process.platform !== "win32" && !existed) chmodSync(options.databasePath, 0o600);
      configureDatabase(database, options.busyTimeoutMs ?? 5_000);
      requireFts5(database);
      initializeOrValidateSchema(database, options.profileId);
      return new SqliteProfileStore(options.profileId, database);
    } catch (error) {
      database?.close();
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to open Profile store");
    }
  }

  public commitMessage(message: NormalizedChannelMessage): ArchiveCommitResult {
    this.#requireOpen();
    validateMessage(message, this.#profileId);
    const recordId = randomUUID();
    try {
      const result = this.#database
        .prepare(
          `INSERT INTO message_archive (
             record_id,
             profile_id,
             provider,
             channel_account_id,
             channel_account_epoch_id,
             provider_event_id,
             conversation_key,
             conversation_kind,
             provider_identity,
             observed_at_ms,
             text_body
           ) VALUES (
             @recordId,
             @profileId,
             @provider,
             @channelAccountId,
             @channelAccountEpochId,
             @providerEventId,
             @conversationKey,
             @conversationKind,
             @providerIdentity,
             @observedAtMs,
             @text
           )
           ON CONFLICT(channel_account_epoch_id, provider_event_id) DO NOTHING`
        )
        .run({ recordId, ...message });
      if (result.changes === 1) return { recordId, inserted: true };
      const existing = this.#database
        .prepare<
          { channelAccountEpochId: string; providerEventId: string },
          { record_id: string }
        >(
          `SELECT record_id
             FROM message_archive
            WHERE channel_account_epoch_id = @channelAccountEpochId
              AND provider_event_id = @providerEventId`
        )
        .get({
          channelAccountEpochId: message.channelAccountEpochId,
          providerEventId: message.providerEventId
        });
      if (!existing) throw new Error("Deduplicated record was not found");
      return { recordId: existing.record_id, inserted: false };
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to commit Channel message");
    }
  }

  public recentMessages(
    conversationKey: string,
    limit = DEFAULT_LIMIT
  ): readonly ArchivedChannelMessage[] {
    this.#requireOpen();
    validateExternalId(conversationKey, "conversationKey");
    const boundedLimit = validateLimit(limit);
    const rows = this.#database
      .prepare<
        { profileId: string; conversationKey: string; limit: number },
        ArchiveRow
      >(
        `SELECT *
           FROM (
             SELECT row_id,
                    record_id,
                    profile_id,
                    provider,
                    channel_account_id,
                    channel_account_epoch_id,
                    provider_event_id,
                    conversation_key,
                    conversation_kind,
                    provider_identity,
                    observed_at_ms,
                    text_body
               FROM message_archive
              WHERE profile_id = @profileId
                AND conversation_key = @conversationKey
              ORDER BY observed_at_ms DESC, row_id DESC
              LIMIT @limit
           )
          ORDER BY observed_at_ms ASC, row_id ASC`
      )
      .all({ profileId: this.#profileId, conversationKey, limit: boundedLimit });
    return rows.map(toArchivedMessage);
  }

  public searchText(query: ArchiveTextSearch): readonly ArchiveTextSearchHit[] {
    this.#requireOpen();
    const expression = literalFtsExpression(query.text);
    const limit = validateLimit(query.limit ?? DEFAULT_LIMIT);
    if (query.conversationKey !== undefined) {
      validateExternalId(query.conversationKey, "conversationKey");
    }
    const rows = this.#database
      .prepare<
        {
          expression: string;
          profileId: string;
          conversationKey: string | null;
          limit: number;
        },
        ArchiveSearchRow
      >(
        `SELECT message_archive.record_id,
                message_archive.profile_id,
                message_archive.provider,
                message_archive.channel_account_id,
                message_archive.channel_account_epoch_id,
                message_archive.provider_event_id,
                message_archive.conversation_key,
                message_archive.conversation_kind,
                message_archive.provider_identity,
                message_archive.observed_at_ms,
                message_archive.text_body,
                bm25(message_archive_fts) AS rank
          FROM message_archive_fts
           JOIN message_archive
             ON message_archive.row_id = message_archive_fts.rowid
          WHERE message_archive_fts MATCH @expression
            AND message_archive.profile_id = @profileId
            AND (@conversationKey IS NULL OR message_archive.conversation_key = @conversationKey)
          ORDER BY rank ASC, message_archive.observed_at_ms DESC
          LIMIT @limit`
      )
      .all({
        expression,
        profileId: this.#profileId,
        conversationKey: query.conversationKey ?? null,
        limit
      });
    return rows.map((row) => ({ ...toArchivedMessage(row), rank: row.rank }));
  }

  public journalMode(): string {
    this.#requireOpen();
    return String(this.#database.pragma("journal_mode", { simple: true })).toLowerCase();
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new ProfileStoreError("storage_failure", "Profile store is closed");
    }
  }
}

function validateOpenOptions(options: OpenProfileStoreOptions): void {
  if (
    !PROFILE_ID_PATTERN.test(options.profileId) ||
    !isAbsolute(options.databasePath) ||
    (options.busyTimeoutMs !== undefined &&
      (!Number.isInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0))
  ) {
    throw new ProfileStoreError(
      "invalid_store_configuration",
      "Profile store configuration is invalid"
    );
  }
}

function assertStorePath(databasePath: string, existed: boolean): void {
  const parent = lstatSync(dirname(databasePath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new ProfileStoreError(
      "insecure_store_path",
      "Profile store parent must be a real directory"
    );
  }
  if (
    process.platform !== "win32" &&
    (parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700)
  ) {
    throw new ProfileStoreError(
      "insecure_store_path",
      "Profile store parent must be owner-only"
    );
  }
  if (!existed) return;
  const file = lstatSync(databasePath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new ProfileStoreError(
      "insecure_store_path",
      "Profile store must be a regular file"
    );
  }
  if (
    process.platform !== "win32" &&
    (file.uid !== process.getuid?.() || (file.mode & 0o777) !== 0o600)
  ) {
    throw new ProfileStoreError(
      "insecure_store_path",
      "Profile store must be owner-only"
    );
  }
}

function fileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function configureDatabase(database: Database.Database, busyTimeoutMs: number): void {
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  database.pragma("foreign_keys = ON");
  database.pragma("synchronous = FULL");
  const mode = String(database.pragma("journal_mode = WAL", { simple: true })).toLowerCase();
  if (mode !== "wal") {
    throw new ProfileStoreError("storage_failure", "Profile store could not enable WAL mode");
  }
}

function requireFts5(database: Database.Database): void {
  try {
    database.exec(
      "CREATE VIRTUAL TABLE temp.bridge_fts5_probe USING fts5(value); DROP TABLE temp.bridge_fts5_probe;"
    );
  } catch {
    throw new ProfileStoreError("fts5_unavailable", "SQLite FTS5 is required");
  }
}

function initializeOrValidateSchema(database: Database.Database, profileId: string): void {
  const version = Number(database.pragma("user_version", { simple: true }));
  if (version === 0) {
    const existing = database
      .prepare<[], { count: number }>(
        `SELECT count(*) AS count
           FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'`
      )
      .get();
    if ((existing?.count ?? 0) !== 0) {
      throw new ProfileStoreError(
        "migration_required",
        "Existing Profile store requires an explicit migration"
      );
    }
    createSchema(database, profileId);
    return;
  }
  if (version !== SCHEMA_VERSION) {
    throw new ProfileStoreError(
      "migration_required",
      "Profile store schema requires an explicit migration"
    );
  }
  const metadata = database
    .prepare<[], { profile_id: string }>(
      "SELECT profile_id FROM profile_metadata WHERE singleton = 1"
    )
    .get();
  if (!metadata) {
    throw new ProfileStoreError("storage_failure", "Profile store metadata is missing");
  }
  if (metadata.profile_id !== profileId) {
    throw new ProfileStoreError(
      "profile_mismatch",
      "Profile store belongs to a different Profile"
    );
  }
}

function createSchema(database: Database.Database, profileId: string): void {
  const initialize = database.transaction(() => {
    database.exec(`
      CREATE TABLE profile_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        profile_id TEXT NOT NULL
      );

      CREATE TABLE message_archive (
        row_id INTEGER PRIMARY KEY,
        record_id TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('qq', 'whatsapp')),
        channel_account_id TEXT NOT NULL,
        channel_account_epoch_id TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('private', 'group')),
        provider_identity TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        text_body TEXT,
        UNIQUE (channel_account_epoch_id, provider_event_id)
      );

      CREATE INDEX message_archive_recent
        ON message_archive (conversation_key, observed_at_ms DESC, row_id DESC);

      CREATE VIRTUAL TABLE message_archive_fts USING fts5(
        text_body,
        content = 'message_archive',
        content_rowid = 'row_id',
        tokenize = 'unicode61'
      );

      CREATE TRIGGER message_archive_ai AFTER INSERT ON message_archive BEGIN
        INSERT INTO message_archive_fts(rowid, text_body)
        VALUES (new.row_id, coalesce(new.text_body, ''));
      END;

      CREATE TRIGGER message_archive_ad AFTER DELETE ON message_archive BEGIN
        INSERT INTO message_archive_fts(message_archive_fts, rowid, text_body)
        VALUES ('delete', old.row_id, coalesce(old.text_body, ''));
      END;

      CREATE TRIGGER message_archive_au AFTER UPDATE OF text_body ON message_archive BEGIN
        INSERT INTO message_archive_fts(message_archive_fts, rowid, text_body)
        VALUES ('delete', old.row_id, coalesce(old.text_body, ''));
        INSERT INTO message_archive_fts(rowid, text_body)
        VALUES (new.row_id, coalesce(new.text_body, ''));
      END;
    `);
    database
      .prepare("INSERT INTO profile_metadata (singleton, profile_id) VALUES (1, ?)")
      .run(profileId);
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  initialize.immediate();
}

function validateMessage(message: NormalizedChannelMessage, profileId: string): void {
  const valid =
    message.profileId === profileId &&
    (message.provider === "qq" || message.provider === "whatsapp") &&
    (message.conversationKind === "private" || message.conversationKind === "group") &&
    Number.isSafeInteger(message.observedAtMs) &&
    message.observedAtMs >= 0 &&
    (message.text === null ||
      (typeof message.text === "string" &&
        Buffer.byteLength(message.text, "utf8") <= MAX_TEXT_BYTES));
  if (!valid) invalidMessage();
  validateExternalId(message.channelAccountId, "channelAccountId");
  validateExternalId(message.channelAccountEpochId, "channelAccountEpochId");
  validateExternalId(message.providerEventId, "providerEventId");
  validateExternalId(message.conversationKey, "conversationKey");
  validateExternalId(message.providerIdentity, "providerIdentity");
}

function validateExternalId(value: string, _field: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_EXTERNAL_ID_BYTES
  ) {
    invalidMessage();
  }
}

function invalidMessage(): never {
  throw new ProfileStoreError("invalid_channel_message", "Channel message is invalid");
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ProfileStoreError("invalid_channel_message", "Archive query limit is invalid");
  }
  return limit;
}

function literalFtsExpression(text: string): string {
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0 || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new ProfileStoreError("invalid_channel_message", "Archive search text is invalid");
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function toArchivedMessage(row: ArchiveRow): ArchivedChannelMessage {
  return {
    recordId: row.record_id,
    profileId: row.profile_id,
    provider: row.provider,
    channelAccountId: row.channel_account_id,
    channelAccountEpochId: row.channel_account_epoch_id,
    providerEventId: row.provider_event_id,
    conversationKey: row.conversation_key,
    conversationKind: row.conversation_kind,
    providerIdentity: row.provider_identity,
    observedAtMs: row.observed_at_ms,
    text: row.text_body
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
