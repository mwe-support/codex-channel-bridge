import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import Database from "better-sqlite3";

import type {
  ChannelConversationKind,
  ChannelProvider,
  CodexInputAcceptance,
  CodexInputCorrelation,
  LogicalResultInput,
  NormalizedChannelMessage,
  ThreadBinding,
  ThreadBindingKey
} from "@codex-channel-bridge/core";

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const SCHEMA_VERSION = 5;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_LOGICAL_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_LOGICAL_RESULT_SEGMENTS = 1_000;
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
  | "invalid_logical_result"
  | "logical_result_conflict"
  | "invalid_thread_binding"
  | "thread_binding_conflict"
  | "invalid_codex_input"
  | "codex_input_conflict"
  | "invalid_outbox_operation"
  | "outbox_lease_conflict"
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

export interface LogicalResultCommitResult {
  readonly logicalResultId: string;
  readonly outboxRecordIds: readonly string[];
  readonly inserted: boolean;
}

export interface CreateThreadBindingInput extends ThreadBindingKey {
  readonly profileId: string;
  readonly codexThreadId: string;
  readonly boundAtMs: number;
}

export interface ThreadBindingCommitResult {
  readonly binding: ThreadBinding;
  readonly inserted: boolean;
}

export interface CodexInputCommitResult {
  readonly correlation: CodexInputCorrelation;
  readonly inserted: boolean;
}

export interface CommitCodexInputUncertaintyInput {
  readonly correlationId: string;
  readonly reasonCode: string;
  readonly completedAtMs: number;
  readonly text: string;
}

export interface CodexInputUncertaintyCommitResult {
  readonly correlation: CodexInputCorrelation;
  readonly logicalResult: LogicalResultCommitResult;
}

export interface CommitCodexTurnResultInput {
  readonly correlationId: string;
  readonly terminalStatus: string;
  readonly updatedAtMs: number;
  readonly result: LogicalResultInput;
}

export interface CodexTurnResultCommitResult {
  readonly correlation: CodexInputCorrelation;
  readonly logicalResult: LogicalResultCommitResult;
}

export type CodexInputTransition =
  | {
      readonly correlationId: string;
      readonly state: "started";
      readonly codexTurnId: string;
      readonly updatedAtMs: number;
    }
  | {
      readonly correlationId: string;
      readonly state: "terminal";
      readonly codexTurnId: string;
      readonly terminalStatus: string;
      readonly updatedAtMs: number;
    }
  | {
      readonly correlationId: string;
      readonly state: "uncertain";
      readonly reasonCode: string;
      readonly updatedAtMs: number;
    };

export interface ClaimOutboxOptions {
  readonly nowMs: number;
  readonly leaseDurationMs: number;
  readonly limit?: number;
}

export interface OutboxDeliveryLease {
  readonly outboxRecordId: string;
  readonly logicalResultId: string;
  readonly segmentIndex: number;
  readonly provider: ChannelProvider;
  readonly channelAccountId: string;
  readonly channelAccountEpochId: string;
  readonly target: {
    readonly conversationKey: string;
    readonly conversationKind: ChannelConversationKind;
    readonly providerConversationId: string;
    readonly providerReplyEventId?: string;
  };
  readonly providerReplySequence?: number;
  readonly text: string;
  readonly attemptNumber: number;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
}

export type OutboxSettlement =
  | {
      readonly outboxRecordId: string;
      readonly leaseToken: string;
      readonly outcome: "accepted";
      readonly providerMessageId: string;
      readonly acceptedAtMs: number;
    }
  | {
      readonly outboxRecordId: string;
      readonly leaseToken: string;
      readonly outcome: "rejected";
      readonly reasonCode: string;
      readonly settledAtMs: number;
    }
  | {
      readonly outboxRecordId: string;
      readonly leaseToken: string;
      readonly outcome: "ambiguous" | "deferred";
      readonly reasonCode: string;
      readonly retryAtMs: number;
      readonly settledAtMs: number;
    };

export interface OutboxSettlementResult {
  readonly outboxRecordId: string;
  readonly logicalResultId: string;
  readonly status: "accepted" | "rejected" | "retry_wait";
}

export interface OutboxCounts {
  readonly pending: number;
  readonly leased: number;
  readonly retryWait: number;
  readonly accepted: number;
  readonly rejected: number;
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
  readonly provider_conversation_id: string;
  readonly provider_identity: string;
  readonly observed_at_ms: number;
  readonly text_body: string | null;
}

interface ArchiveSearchRow extends ArchiveRow {
  readonly rank: number;
}

interface LogicalResultRow {
  readonly logical_result_id: string;
  readonly payload_digest: string;
}

type DurableResultInput = Omit<LogicalResultInput, "codexTurnId"> & {
  readonly sourceKind: "codex_turn" | "codex_input_uncertainty";
  readonly sourceId: string;
  readonly codexTurnId?: string;
};

interface OutboxIdRow {
  readonly outbox_record_id: string;
}

interface OutboxClaimRow {
  readonly outbox_record_id: string;
  readonly logical_result_id: string;
  readonly segment_index: number;
  readonly provider: ChannelProvider;
  readonly channel_account_id: string;
  readonly channel_account_epoch_id: string;
  readonly conversation_key: string;
  readonly conversation_kind: ChannelConversationKind;
  readonly provider_conversation_id: string;
  readonly provider_reply_event_id: string | null;
  readonly provider_reply_sequence: number | null;
  readonly text_body: string;
  readonly attempt_count: number;
}

interface OutboxSettlementRow {
  readonly logical_result_id: string;
  readonly segment_index: number;
}

interface ReplySequenceRow {
  readonly next_sequence: number;
}

interface OutboxCountRow {
  readonly status: "pending" | "leased" | "retry_wait" | "accepted" | "rejected";
  readonly count: number;
}

interface ThreadBindingRow {
  readonly binding_id: string;
  readonly profile_id: string;
  readonly conversation_key: string;
  readonly scope: "conversation" | "participant";
  readonly scope_identity: string;
  readonly codex_thread_id: string;
  readonly bound_at_ms: number;
}

interface CodexInputRow {
  readonly correlation_id: string;
  readonly profile_id: string;
  readonly archive_record_id: string;
  readonly binding_id: string;
  readonly codex_thread_id: string;
  readonly client_user_message_id: string;
  readonly state: "accepted" | "started" | "terminal" | "uncertain";
  readonly codex_turn_id: string | null;
  readonly terminal_status: string | null;
  readonly reason_code: string | null;
  readonly accepted_at_ms: number;
  readonly updated_at_ms: number;
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
             provider_conversation_id,
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
             @providerConversationId,
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
                    provider_conversation_id,
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
                message_archive.provider_conversation_id,
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

  public getThreadBinding(key: ThreadBindingKey): ThreadBinding | undefined {
    this.#requireOpen();
    validateThreadBindingKey(key);
    const row = this.#database
      .prepare<
        { profileId: string; conversationKey: string; scope: string; scopeIdentity: string },
        ThreadBindingRow
      >(
        `SELECT binding_id,
                profile_id,
                conversation_key,
                scope,
                scope_identity,
                codex_thread_id,
                bound_at_ms
           FROM thread_bindings
          WHERE profile_id = @profileId
            AND conversation_key = @conversationKey
            AND scope = @scope
            AND scope_identity = @scopeIdentity`
      )
      .get({
        profileId: this.#profileId,
        conversationKey: key.conversationKey,
        scope: key.scope,
        scopeIdentity: bindingScopeIdentity(key)
      });
    return row ? toThreadBinding(row) : undefined;
  }

  public createThreadBinding(input: CreateThreadBindingInput): ThreadBindingCommitResult {
    this.#requireOpen();
    validateCreateThreadBinding(input, this.#profileId);
    try {
      const existing = this.getThreadBinding(input);
      if (existing) return { binding: existing, inserted: false };
      const bindingId = randomUUID();
      this.#database
        .prepare(
          `INSERT INTO thread_bindings (
             binding_id,
             profile_id,
             conversation_key,
             scope,
             scope_identity,
             codex_thread_id,
             bound_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          bindingId,
          input.profileId,
          input.conversationKey,
          input.scope,
          bindingScopeIdentity(input),
          input.codexThreadId,
          input.boundAtMs
        );
      return {
        binding: {
          bindingId,
          profileId: input.profileId,
          conversationKey: input.conversationKey,
          scope: input.scope,
          ...(input.scope === "participant" ? { providerIdentity: input.providerIdentity } : {}),
          codexThreadId: input.codexThreadId,
          boundAtMs: input.boundAtMs
        },
        inserted: true
      };
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to create Thread Binding");
    }
  }

  public acceptCodexInput(input: CodexInputAcceptance): CodexInputCommitResult {
    this.#requireOpen();
    validateCodexInputAcceptance(input, this.#profileId);
    try {
      const authority = this.#database
        .prepare<
          { profileId: string; archiveRecordId: string; bindingId: string; codexThreadId: string },
          { valid: number }
        >(
          `SELECT 1 AS valid
             FROM message_archive AS archive
             JOIN thread_bindings AS binding
               ON binding.binding_id = @bindingId
              AND binding.profile_id = @profileId
              AND binding.codex_thread_id = @codexThreadId
            WHERE archive.record_id = @archiveRecordId
              AND archive.profile_id = @profileId`
        )
        .get(input);
      if (!authority) {
        throw new ProfileStoreError(
          "invalid_codex_input",
          "Codex input does not match its archived message and Thread Binding"
        );
      }
      const existing = this.#database
        .prepare<{ archiveRecordId: string }, CodexInputRow>(
          `SELECT * FROM codex_input_correlations WHERE archive_record_id = @archiveRecordId`
        )
        .get({ archiveRecordId: input.archiveRecordId });
      if (existing) {
        const correlation = toCodexInputCorrelation(existing);
        if (!sameCodexInputAcceptance(correlation, input)) {
          throw new ProfileStoreError(
            "codex_input_conflict",
            "Archived Channel input already has a different Codex correlation"
          );
        }
        return { correlation, inserted: false };
      }
      const correlationId = randomUUID();
      this.#database
        .prepare(
          `INSERT INTO codex_input_correlations (
             correlation_id,
             profile_id,
             archive_record_id,
             binding_id,
             codex_thread_id,
             client_user_message_id,
             state,
             accepted_at_ms,
             updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`
        )
        .run(
          correlationId,
          input.profileId,
          input.archiveRecordId,
          input.bindingId,
          input.codexThreadId,
          input.clientUserMessageId,
          input.acceptedAtMs,
          input.acceptedAtMs
        );
      return {
        correlation: {
          correlationId,
          ...input,
          state: "accepted",
          updatedAtMs: input.acceptedAtMs
        },
        inserted: true
      };
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to accept Codex input");
    }
  }

  public transitionCodexInput(transition: CodexInputTransition): CodexInputCorrelation {
    this.#requireOpen();
    validateCodexInputTransition(transition);
    try {
      const current = this.#codexInputById(transition.correlationId);
      if (!current) {
        throw new ProfileStoreError("invalid_codex_input", "Codex input correlation was not found");
      }
      if (codexInputTransitionIsReplay(current, transition)) return current;
      if (!codexInputTransitionAllowed(current, transition)) {
        throw new ProfileStoreError(
          "codex_input_conflict",
          `Cannot transition Codex input from ${current.state} to ${transition.state}`
        );
      }
      this.#database
        .prepare(
          `UPDATE codex_input_correlations
              SET state = @state,
                  codex_turn_id = coalesce(@codexTurnId, codex_turn_id),
                  terminal_status = @terminalStatus,
                  reason_code = @reasonCode,
                  updated_at_ms = @updatedAtMs
            WHERE correlation_id = @correlationId`
        )
        .run({
          correlationId: transition.correlationId,
          state: transition.state,
          codexTurnId: "codexTurnId" in transition ? transition.codexTurnId : null,
          terminalStatus: "terminalStatus" in transition ? transition.terminalStatus : null,
          reasonCode: "reasonCode" in transition ? transition.reasonCode : null,
          updatedAtMs: transition.updatedAtMs
        });
      return this.#codexInputById(transition.correlationId)!;
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to transition Codex input");
    }
  }

  public nonterminalCodexInputs(): readonly CodexInputCorrelation[] {
    this.#requireOpen();
    try {
      return this.#database
        .prepare<{ profileId: string }, CodexInputRow>(
          `SELECT *
             FROM codex_input_correlations
            WHERE profile_id = @profileId
              AND state IN ('accepted', 'started')
            ORDER BY accepted_at_ms ASC, row_id ASC`
        )
        .all({ profileId: this.#profileId })
        .map(toCodexInputCorrelation);
    } catch {
      throw new ProfileStoreError("storage_failure", "Unable to list nonterminal Codex inputs");
    }
  }

  public commitLogicalResult(input: LogicalResultInput): LogicalResultCommitResult {
    this.#requireOpen();
    validateLogicalResult(input, this.#profileId);
    const durableInput: DurableResultInput = {
      ...input,
      sourceKind: "codex_turn",
      sourceId: input.codexTurnId
    };
    const commit = this.#database.transaction(() => this.#commitDurableResult(durableInput));

    try {
      return commit.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to commit Logical Result");
    }
  }

  /** Atomically closes one started correlation and queues its terminal result. */
  public commitCodexTurnResult(
    input: CommitCodexTurnResultInput
  ): CodexTurnResultCommitResult {
    this.#requireOpen();
    validateLogicalResult(input.result, this.#profileId);
    if (!input.correlationId || !input.terminalStatus || !Number.isSafeInteger(input.updatedAtMs)) {
      throw new ProfileStoreError("invalid_codex_input", "Invalid Codex Turn result commit");
    }
    const commit = this.#database.transaction((): CodexTurnResultCommitResult => {
      const current = this.#codexInputById(input.correlationId);
      if (!current) {
        throw new ProfileStoreError("invalid_codex_input", "Codex input correlation was not found");
      }
      if (
        current.codexThreadId !== input.result.codexThreadId ||
        current.codexTurnId !== input.result.codexTurnId
      ) {
        throw new ProfileStoreError(
          "codex_input_conflict",
          "Terminal result does not match the correlated Codex Turn"
        );
      }
      if (current.state === "terminal") {
        if (current.terminalStatus !== input.terminalStatus) {
          throw new ProfileStoreError(
            "codex_input_conflict",
            "Codex input already has a different terminal status"
          );
        }
      } else if (current.state !== "started") {
        throw new ProfileStoreError(
          "codex_input_conflict",
          `Cannot commit a terminal result from ${current.state}`
        );
      } else {
        if (input.updatedAtMs < current.updatedAtMs) {
          throw new ProfileStoreError("codex_input_conflict", "Terminal result timestamp is stale");
        }
        this.#database
          .prepare(
            `UPDATE codex_input_correlations
                SET state = 'terminal',
                    codex_turn_id = @codexTurnId,
                    terminal_status = @terminalStatus,
                    reason_code = NULL,
                    updated_at_ms = @updatedAtMs
              WHERE correlation_id = @correlationId`
          )
          .run({
            correlationId: input.correlationId,
            codexTurnId: input.result.codexTurnId,
            terminalStatus: input.terminalStatus,
            updatedAtMs: input.updatedAtMs
          });
      }
      const logicalResult = this.#commitDurableResult({
        ...input.result,
        sourceKind: "codex_turn",
        sourceId: input.result.codexTurnId
      });
      return {
        correlation: this.#codexInputById(input.correlationId)!,
        logicalResult
      };
    });

    try {
      return commit.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to commit Codex Turn result");
    }
  }

  /** Atomically closes one uncertain correlation and queues its Channel notification. */
  public commitCodexInputUncertainty(
    input: CommitCodexInputUncertaintyInput
  ): CodexInputUncertaintyCommitResult {
    this.#requireOpen();
    validateCodexInputUncertainty(input);
    const commit = this.#database.transaction((): CodexInputUncertaintyCommitResult => {
      const current = this.#codexInputById(input.correlationId);
      if (!current) {
        throw new ProfileStoreError("invalid_codex_input", "Codex input correlation was not found");
      }
      if (current.state !== "accepted" && current.state !== "started") {
        throw new ProfileStoreError(
          "codex_input_conflict",
          "Codex input was settled before uncertainty could be committed"
        );
      }
      if (input.completedAtMs < current.updatedAtMs) {
        throw new ProfileStoreError("codex_input_conflict", "Uncertainty timestamp is stale");
      }
      const archive = this.#database
        .prepare<{ recordId: string; profileId: string }, ArchiveRow>(
          `SELECT *
             FROM message_archive
            WHERE record_id = @recordId
              AND profile_id = @profileId`
        )
        .get({ recordId: current.archiveRecordId, profileId: this.#profileId });
      if (!archive) {
        throw new ProfileStoreError(
          "invalid_codex_input",
          "Codex input archive record was not found"
        );
      }
      this.#database
        .prepare(
          `UPDATE codex_input_correlations
              SET state = 'uncertain',
                  terminal_status = NULL,
                  reason_code = @reasonCode,
                  updated_at_ms = @completedAtMs
            WHERE correlation_id = @correlationId`
        )
        .run(input);
      const logicalResult = this.#commitDurableResult({
        profileId: this.#profileId,
        sourceKind: "codex_input_uncertainty",
        sourceId: current.correlationId,
        codexThreadId: current.codexThreadId,
        ...(current.codexTurnId ? { codexTurnId: current.codexTurnId } : {}),
        provider: archive.provider,
        channelAccountId: archive.channel_account_id,
        channelAccountEpochId: archive.channel_account_epoch_id,
        target: {
          conversationKey: archive.conversation_key,
          conversationKind: archive.conversation_kind,
          providerConversationId: archive.provider_conversation_id,
          providerReplyEventId: archive.provider_event_id
        },
        completedAtMs: input.completedAtMs,
        segments: [{ text: input.text }]
      });
      return {
        correlation: this.#codexInputById(current.correlationId)!,
        logicalResult
      };
    });

    try {
      return commit.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError(
        "storage_failure",
        "Unable to commit Codex input uncertainty"
      );
    }
  }

  #commitDurableResult(input: DurableResultInput): LogicalResultCommitResult {
    const payloadDigest = durableResultDigest(input);
    const existing = this.#database
      .prepare<
        { profileId: string; sourceKind: string; sourceId: string },
        LogicalResultRow
      >(
        `SELECT logical_result_id, payload_digest
             FROM logical_results
            WHERE profile_id = @profileId
              AND source_kind = @sourceKind
              AND source_id = @sourceId`
      )
      .get(input);
    if (existing) {
      if (existing.payload_digest !== payloadDigest) {
        throw new ProfileStoreError(
          "logical_result_conflict",
          "Codex Turn already has a different Logical Result"
        );
      }
      return {
        logicalResultId: existing.logical_result_id,
        outboxRecordIds: this.#outboxIds(existing.logical_result_id),
        inserted: false
      };
    }

    const logicalResultId = randomUUID();
    this.#database
      .prepare(
        `INSERT INTO logical_results (
             logical_result_id,
             profile_id,
             source_kind,
             source_id,
             codex_thread_id,
             codex_turn_id,
             completed_at_ms,
             payload_digest,
             segment_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        logicalResultId,
        input.profileId,
        input.sourceKind,
        input.sourceId,
        input.codexThreadId,
        input.codexTurnId ?? null,
        input.completedAtMs,
        payloadDigest,
        input.segments.length
      );

    const insertOutbox = this.#database.prepare(
      `INSERT INTO delivery_outbox (
           outbox_record_id,
           logical_result_id,
           profile_id,
           segment_index,
           provider,
           channel_account_id,
           channel_account_epoch_id,
           conversation_key,
           conversation_kind,
           provider_conversation_id,
           provider_reply_event_id,
           provider_reply_sequence,
           text_body,
           status,
           attempt_count,
           next_attempt_at_ms,
           created_at_ms,
           updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
    );
    const replySequences = allocateReplySequences(this.#database, input);
    const outboxRecordIds = input.segments.map((segment, segmentIndex) => {
      const outboxRecordId = randomUUID();
      insertOutbox.run(
        outboxRecordId,
        logicalResultId,
        input.profileId,
        segmentIndex,
        input.provider,
        input.channelAccountId,
        input.channelAccountEpochId,
        input.target.conversationKey,
        input.target.conversationKind,
        input.target.providerConversationId,
        input.target.providerReplyEventId ?? null,
        replySequences[segmentIndex],
        segment.text,
        input.completedAtMs,
        input.completedAtMs,
        input.completedAtMs
      );
      return outboxRecordId;
    });
    return { logicalResultId, outboxRecordIds, inserted: true };
  }

  public claimOutbox(options: ClaimOutboxOptions): readonly OutboxDeliveryLease[] {
    this.#requireOpen();
    validateClaimOptions(options);
    const limit = options.limit ?? DEFAULT_LIMIT;
    const leaseExpiresAtMs = options.nowMs + options.leaseDurationMs;
    const claim = this.#database.transaction((): readonly OutboxDeliveryLease[] => {
      this.#database
        .prepare(
          `UPDATE delivery_outbox
              SET status = 'retry_wait',
                  lease_token = NULL,
                  lease_expires_at_ms = NULL,
                  last_outcome = 'ambiguous',
                  last_reason_code = 'lease_expired',
                  next_attempt_at_ms = @nowMs,
                  updated_at_ms = @nowMs
            WHERE profile_id = @profileId
              AND status = 'leased'
              AND lease_expires_at_ms <= @nowMs`
        )
        .run({ profileId: this.#profileId, nowMs: options.nowMs });

      const rows = this.#database
        .prepare<
          { profileId: string; nowMs: number; limit: number },
          OutboxClaimRow
        >(
          `SELECT current.outbox_record_id,
                  current.logical_result_id,
                  current.segment_index,
                  current.provider,
                  current.channel_account_id,
                  current.channel_account_epoch_id,
                  current.conversation_key,
                  current.conversation_kind,
                  current.provider_conversation_id,
                  current.provider_reply_event_id,
                  current.provider_reply_sequence,
                  current.text_body,
                  current.attempt_count
             FROM delivery_outbox AS current
            WHERE current.profile_id = @profileId
              AND current.status IN ('pending', 'retry_wait')
              AND current.next_attempt_at_ms <= @nowMs
              AND NOT EXISTS (
                    SELECT 1
                      FROM delivery_outbox AS prior
                     WHERE prior.logical_result_id = current.logical_result_id
                       AND prior.segment_index < current.segment_index
                       AND prior.status <> 'accepted'
                  )
            ORDER BY current.created_at_ms ASC,
                     current.logical_result_id ASC,
                     current.segment_index ASC
            LIMIT @limit`
        )
        .all({ profileId: this.#profileId, nowMs: options.nowMs, limit });

      const update = this.#database.prepare(
        `UPDATE delivery_outbox
            SET status = 'leased',
                attempt_count = attempt_count + 1,
                lease_token = @leaseToken,
                lease_expires_at_ms = @leaseExpiresAtMs,
                updated_at_ms = @nowMs
          WHERE outbox_record_id = @outboxRecordId
            AND status IN ('pending', 'retry_wait')`
      );
      return rows.map((row) => {
        const leaseToken = randomUUID();
        const updated = update.run({
          outboxRecordId: row.outbox_record_id,
          leaseToken,
          leaseExpiresAtMs,
          nowMs: options.nowMs
        });
        if (updated.changes !== 1) {
          throw new ProfileStoreError("storage_failure", "Unable to lease Outbox record");
        }
        return toOutboxLease(row, leaseToken, leaseExpiresAtMs);
      });
    });

    try {
      return claim.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to claim Outbox records");
    }
  }

  public settleOutbox(settlement: OutboxSettlement): OutboxSettlementResult {
    this.#requireOpen();
    validateSettlement(settlement);
    const settle = this.#database.transaction((): OutboxSettlementResult => {
      const row = this.#database
        .prepare<
          { outboxRecordId: string; leaseToken: string; profileId: string },
          OutboxSettlementRow
        >(
          `SELECT logical_result_id, segment_index
             FROM delivery_outbox
            WHERE outbox_record_id = @outboxRecordId
              AND profile_id = @profileId
              AND status = 'leased'
              AND lease_token = @leaseToken`
        )
        .get({
          outboxRecordId: settlement.outboxRecordId,
          leaseToken: settlement.leaseToken,
          profileId: this.#profileId
        });
      if (!row) {
        throw new ProfileStoreError(
          "outbox_lease_conflict",
          "Outbox settlement does not match an active lease"
        );
      }

      if (settlement.outcome === "accepted") {
        this.#database
          .prepare(
            `UPDATE delivery_outbox
                SET status = 'accepted',
                    lease_token = NULL,
                    lease_expires_at_ms = NULL,
                    last_outcome = 'accepted',
                    last_reason_code = NULL,
                    provider_message_id = @providerMessageId,
                    accepted_at_ms = @acceptedAtMs,
                    updated_at_ms = @acceptedAtMs
              WHERE outbox_record_id = @outboxRecordId`
          )
          .run({
            outboxRecordId: settlement.outboxRecordId,
            providerMessageId: settlement.providerMessageId,
            acceptedAtMs: settlement.acceptedAtMs
          });
        return {
          outboxRecordId: settlement.outboxRecordId,
          logicalResultId: row.logical_result_id,
          status: "accepted"
        };
      }

      if (settlement.outcome === "ambiguous" || settlement.outcome === "deferred") {
        this.#database
          .prepare(
            `UPDATE delivery_outbox
                SET status = 'retry_wait',
                    lease_token = NULL,
                    lease_expires_at_ms = NULL,
                    last_outcome = @outcome,
                    last_reason_code = @reasonCode,
                    next_attempt_at_ms = @retryAtMs,
                    updated_at_ms = @settledAtMs
              WHERE outbox_record_id = @outboxRecordId`
          )
          .run({
            outboxRecordId: settlement.outboxRecordId,
            outcome: settlement.outcome,
            reasonCode: settlement.reasonCode,
            retryAtMs: settlement.retryAtMs,
            settledAtMs: settlement.settledAtMs
          });
        return {
          outboxRecordId: settlement.outboxRecordId,
          logicalResultId: row.logical_result_id,
          status: "retry_wait"
        };
      }

      this.#database
        .prepare(
          `UPDATE delivery_outbox
              SET status = 'rejected',
                  lease_token = NULL,
                  lease_expires_at_ms = NULL,
                  last_outcome = 'rejected',
                  last_reason_code = @reasonCode,
                  updated_at_ms = @settledAtMs
            WHERE outbox_record_id = @outboxRecordId`
        )
        .run(settlement);
      this.#database
        .prepare(
          `UPDATE delivery_outbox
              SET status = 'rejected',
                  last_outcome = 'rejected',
                  last_reason_code = 'prior_segment_rejected',
                  updated_at_ms = @settledAtMs
            WHERE logical_result_id = @logicalResultId
              AND segment_index > @segmentIndex
              AND status IN ('pending', 'retry_wait')`
        )
        .run({
          logicalResultId: row.logical_result_id,
          segmentIndex: row.segment_index,
          settledAtMs: settlement.settledAtMs
        });
      return {
        outboxRecordId: settlement.outboxRecordId,
        logicalResultId: row.logical_result_id,
        status: "rejected"
      };
    });

    try {
      return settle.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to settle Outbox record");
    }
  }

  public outboxCounts(): OutboxCounts {
    this.#requireOpen();
    const rows = this.#database
      .prepare<{ profileId: string }, OutboxCountRow>(
        `SELECT status, count(*) AS count
           FROM delivery_outbox
          WHERE profile_id = @profileId
          GROUP BY status`
      )
      .all({ profileId: this.#profileId });
    const counts = new Map(rows.map((row) => [row.status, row.count] as const));
    return {
      pending: counts.get("pending") ?? 0,
      leased: counts.get("leased") ?? 0,
      retryWait: counts.get("retry_wait") ?? 0,
      accepted: counts.get("accepted") ?? 0,
      rejected: counts.get("rejected") ?? 0
    };
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

  #codexInputById(correlationId: string): CodexInputCorrelation | undefined {
    const row = this.#database
      .prepare<{ correlationId: string; profileId: string }, CodexInputRow>(
        `SELECT *
           FROM codex_input_correlations
          WHERE correlation_id = @correlationId
            AND profile_id = @profileId`
      )
      .get({ correlationId, profileId: this.#profileId });
    return row ? toCodexInputCorrelation(row) : undefined;
  }

  #outboxIds(logicalResultId: string): readonly string[] {
    return this.#database
      .prepare<{ logicalResultId: string }, OutboxIdRow>(
        `SELECT outbox_record_id
           FROM delivery_outbox
          WHERE logical_result_id = @logicalResultId
          ORDER BY segment_index ASC`
      )
      .all({ logicalResultId })
      .map((row) => row.outbox_record_id);
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
        provider_conversation_id TEXT NOT NULL,
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

      CREATE TABLE thread_bindings (
        row_id INTEGER PRIMARY KEY,
        binding_id TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('conversation', 'participant')),
        scope_identity TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        bound_at_ms INTEGER NOT NULL,
        CHECK (
          (scope = 'conversation' AND scope_identity = '') OR
          (scope = 'participant' AND length(scope_identity) > 0)
        ),
        UNIQUE (profile_id, conversation_key, scope, scope_identity)
      );

      CREATE TABLE codex_input_correlations (
        row_id INTEGER PRIMARY KEY,
        correlation_id TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL,
        archive_record_id TEXT NOT NULL UNIQUE REFERENCES message_archive(record_id),
        binding_id TEXT NOT NULL REFERENCES thread_bindings(binding_id),
        codex_thread_id TEXT NOT NULL,
        client_user_message_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'started', 'terminal', 'uncertain')),
        codex_turn_id TEXT,
        terminal_status TEXT,
        reason_code TEXT,
        accepted_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (state <> 'started' OR codex_turn_id IS NOT NULL),
        CHECK (state <> 'terminal' OR (codex_turn_id IS NOT NULL AND terminal_status IS NOT NULL)),
        CHECK (state <> 'uncertain' OR reason_code IS NOT NULL)
      );

      CREATE INDEX codex_input_by_thread
        ON codex_input_correlations (profile_id, codex_thread_id, accepted_at_ms DESC);

      CREATE TABLE logical_results (
        row_id INTEGER PRIMARY KEY,
        logical_result_id TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('codex_turn', 'codex_input_uncertainty')),
        source_id TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT,
        completed_at_ms INTEGER NOT NULL,
        payload_digest TEXT NOT NULL,
        segment_count INTEGER NOT NULL CHECK (segment_count > 0),
        CHECK (source_kind <> 'codex_turn' OR codex_turn_id IS NOT NULL),
        UNIQUE (profile_id, source_kind, source_id)
      );

      CREATE TABLE delivery_outbox (
        row_id INTEGER PRIMARY KEY,
        outbox_record_id TEXT NOT NULL UNIQUE,
        logical_result_id TEXT NOT NULL REFERENCES logical_results(logical_result_id),
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

      CREATE INDEX delivery_outbox_ready
        ON delivery_outbox (profile_id, status, next_attempt_at_ms, created_at_ms);

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
  validateExternalId(message.providerConversationId, "providerConversationId");
  validateExternalId(message.providerIdentity, "providerIdentity");
}

function validateThreadBindingKey(key: ThreadBindingKey): void {
  const valid =
    validExternalId(key.conversationKey) &&
    ((key.scope === "conversation" && key.providerIdentity === undefined) ||
      (key.scope === "participant" && validExternalId(key.providerIdentity)));
  if (!valid) {
    throw new ProfileStoreError("invalid_thread_binding", "Thread Binding key is invalid");
  }
}

function validateCreateThreadBinding(
  input: CreateThreadBindingInput,
  profileId: string
): void {
  validateThreadBindingKey(input);
  if (
    input.profileId !== profileId ||
    !validExternalId(input.codexThreadId) ||
    !Number.isSafeInteger(input.boundAtMs) ||
    input.boundAtMs < 0
  ) {
    throw new ProfileStoreError("invalid_thread_binding", "Thread Binding input is invalid");
  }
}

function bindingScopeIdentity(key: ThreadBindingKey): string {
  return key.scope === "participant" ? key.providerIdentity! : "";
}

function validateCodexInputAcceptance(
  input: CodexInputAcceptance,
  profileId: string
): void {
  if (
    input.profileId !== profileId ||
    !validExternalId(input.archiveRecordId) ||
    !validExternalId(input.bindingId) ||
    !validExternalId(input.codexThreadId) ||
    !validExternalId(input.clientUserMessageId) ||
    !Number.isSafeInteger(input.acceptedAtMs) ||
    input.acceptedAtMs < 0
  ) {
    throw new ProfileStoreError("invalid_codex_input", "Codex input acceptance is invalid");
  }
}

function validateCodexInputTransition(transition: CodexInputTransition): void {
  const valid =
    validExternalId(transition.correlationId) &&
    Number.isSafeInteger(transition.updatedAtMs) &&
    transition.updatedAtMs >= 0 &&
    (transition.state === "started"
      ? validExternalId(transition.codexTurnId)
      : transition.state === "terminal"
        ? validExternalId(transition.codexTurnId) && validExternalId(transition.terminalStatus)
        : validExternalId(transition.reasonCode));
  if (!valid) {
    throw new ProfileStoreError("invalid_codex_input", "Codex input transition is invalid");
  }
}

function sameCodexInputAcceptance(
  current: CodexInputCorrelation,
  input: CodexInputAcceptance
): boolean {
  return (
    current.profileId === input.profileId &&
    current.archiveRecordId === input.archiveRecordId &&
    current.bindingId === input.bindingId &&
    current.codexThreadId === input.codexThreadId &&
    current.clientUserMessageId === input.clientUserMessageId
  );
}

function codexInputTransitionAllowed(
  current: CodexInputCorrelation,
  transition: CodexInputTransition
): boolean {
  if (transition.updatedAtMs < current.updatedAtMs) return false;
  if (current.state === "accepted") {
    return transition.state === "started" || transition.state === "uncertain";
  }
  if (current.state === "started") {
    return transition.state === "terminal" || transition.state === "uncertain";
  }
  return false;
}

function codexInputTransitionIsReplay(
  current: CodexInputCorrelation,
  transition: CodexInputTransition
): boolean {
  if (current.state !== transition.state) return false;
  if (transition.state === "started") return current.codexTurnId === transition.codexTurnId;
  if (transition.state === "terminal") {
    return (
      current.codexTurnId === transition.codexTurnId &&
      current.terminalStatus === transition.terminalStatus
    );
  }
  return current.reasonCode === transition.reasonCode;
}

function validateLogicalResult(input: LogicalResultInput, profileId: string): void {
  const validSegments =
    Array.isArray(input.segments) &&
    input.segments.length >= 1 &&
    input.segments.length <= MAX_LOGICAL_RESULT_SEGMENTS &&
    input.segments.every(
      (segment) =>
        typeof segment === "object" &&
        segment !== null &&
        typeof segment.text === "string" &&
        segment.text.length > 0 &&
        Buffer.byteLength(segment.text, "utf8") <= MAX_TEXT_BYTES
    );
  const totalBytes = validSegments
    ? input.segments.reduce((total, segment) => total + Buffer.byteLength(segment.text, "utf8"), 0)
    : 0;
  const valid =
    input.profileId === profileId &&
    (input.provider === "qq" || input.provider === "whatsapp") &&
    (input.target.conversationKind === "private" || input.target.conversationKind === "group") &&
    Number.isSafeInteger(input.completedAtMs) &&
    input.completedAtMs >= 0 &&
    validSegments &&
    totalBytes <= MAX_LOGICAL_RESULT_BYTES &&
    validExternalId(input.codexThreadId) &&
    validExternalId(input.codexTurnId) &&
    validExternalId(input.channelAccountId) &&
    validExternalId(input.channelAccountEpochId) &&
    validExternalId(input.target.conversationKey) &&
    validExternalId(input.target.providerConversationId) &&
    (input.target.providerReplyEventId === undefined ||
      validExternalId(input.target.providerReplyEventId));
  if (!valid) {
    throw new ProfileStoreError("invalid_logical_result", "Logical Result is invalid");
  }
}

function validateCodexInputUncertainty(input: CommitCodexInputUncertaintyInput): void {
  if (
    !validExternalId(input.correlationId) ||
    !validExternalId(input.reasonCode) ||
    !Number.isSafeInteger(input.completedAtMs) ||
    input.completedAtMs < 0 ||
    typeof input.text !== "string" ||
    input.text.length === 0 ||
    Buffer.byteLength(input.text, "utf8") > MAX_TEXT_BYTES
  ) {
    throw new ProfileStoreError("invalid_codex_input", "Codex input uncertainty is invalid");
  }
}

function durableResultDigest(input: DurableResultInput): string {
  const canonical = JSON.stringify([
    input.profileId,
    input.sourceKind,
    input.sourceId,
    input.codexThreadId,
    input.codexTurnId ?? null,
    input.provider,
    input.channelAccountId,
    input.channelAccountEpochId,
    input.target.conversationKey,
    input.target.conversationKind,
    input.target.providerConversationId,
    input.target.providerReplyEventId ?? null,
    input.segments.map((segment) => segment.text)
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function allocateReplySequences(
  database: Database.Database,
  input: Pick<
    DurableResultInput,
    "provider" | "profileId" | "channelAccountId" | "channelAccountEpochId" | "target" | "segments"
  >
): readonly (number | null)[] {
  if (input.provider !== "qq" || !input.target.providerReplyEventId) {
    return input.segments.map(() => null);
  }
  const key = {
    profileId: input.profileId,
    provider: input.provider,
    channelAccountId: input.channelAccountId,
    channelAccountEpochId: input.channelAccountEpochId,
    providerReplyEventId: input.target.providerReplyEventId
  };
  const current = database
    .prepare<typeof key, ReplySequenceRow>(
      `SELECT next_sequence
         FROM delivery_reply_sequences
        WHERE profile_id = @profileId
          AND provider = @provider
          AND channel_account_id = @channelAccountId
          AND channel_account_epoch_id = @channelAccountEpochId
          AND provider_reply_event_id = @providerReplyEventId`
    )
    .get(key);
  const first = current?.next_sequence ?? 1;
  const next = first + input.segments.length;
  if (!Number.isSafeInteger(next)) {
    throw new ProfileStoreError("invalid_logical_result", "Provider reply sequence is invalid");
  }
  if (current) {
    database
      .prepare(
        `UPDATE delivery_reply_sequences
            SET next_sequence = @nextSequence
          WHERE profile_id = @profileId
            AND provider = @provider
            AND channel_account_id = @channelAccountId
            AND channel_account_epoch_id = @channelAccountEpochId
            AND provider_reply_event_id = @providerReplyEventId`
      )
      .run({ ...key, nextSequence: next });
  } else {
    database
      .prepare(
        `INSERT INTO delivery_reply_sequences (
           profile_id,
           provider,
           channel_account_id,
           channel_account_epoch_id,
           provider_reply_event_id,
           next_sequence
         ) VALUES (
           @profileId,
           @provider,
           @channelAccountId,
           @channelAccountEpochId,
           @providerReplyEventId,
           @nextSequence
         )`
      )
      .run({ ...key, nextSequence: next });
  }
  return input.segments.map((_segment, index) => first + index);
}

function validateClaimOptions(options: ClaimOutboxOptions): void {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(options.nowMs) ||
    options.nowMs < 0 ||
    !Number.isSafeInteger(options.leaseDurationMs) ||
    options.leaseDurationMs < 1 ||
    !Number.isSafeInteger(options.nowMs + options.leaseDurationMs) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT
  ) {
    throw new ProfileStoreError("invalid_outbox_operation", "Outbox claim is invalid");
  }
}

function validateSettlement(settlement: OutboxSettlement): void {
  let valid = validExternalId(settlement.outboxRecordId) && validExternalId(settlement.leaseToken);
  if (settlement.outcome === "accepted") {
    valid =
      valid &&
      validExternalId(settlement.providerMessageId) &&
      Number.isSafeInteger(settlement.acceptedAtMs) &&
      settlement.acceptedAtMs >= 0;
  } else {
    valid =
      valid &&
      /^[a-z][a-z0-9_]{0,127}$/u.test(settlement.reasonCode) &&
      Number.isSafeInteger(settlement.settledAtMs) &&
      settlement.settledAtMs >= 0;
    if (settlement.outcome === "ambiguous") {
      valid =
        valid &&
        Number.isSafeInteger(settlement.retryAtMs) &&
        settlement.retryAtMs >= settlement.settledAtMs;
    }
  }
  if (!valid) {
    throw new ProfileStoreError("invalid_outbox_operation", "Outbox settlement is invalid");
  }
}

function toOutboxLease(
  row: OutboxClaimRow,
  leaseToken: string,
  leaseExpiresAtMs: number
): OutboxDeliveryLease {
  return {
    outboxRecordId: row.outbox_record_id,
    logicalResultId: row.logical_result_id,
    segmentIndex: row.segment_index,
    provider: row.provider,
    channelAccountId: row.channel_account_id,
    channelAccountEpochId: row.channel_account_epoch_id,
    target: {
      conversationKey: row.conversation_key,
      conversationKind: row.conversation_kind,
      providerConversationId: row.provider_conversation_id,
      ...(row.provider_reply_event_id
        ? { providerReplyEventId: row.provider_reply_event_id }
        : {})
    },
    ...(row.provider_reply_sequence !== null
      ? { providerReplySequence: row.provider_reply_sequence }
      : {}),
    text: row.text_body,
    attemptNumber: row.attempt_count + 1,
    leaseToken,
    leaseExpiresAtMs
  };
}

function validateExternalId(value: string, _field: string): void {
  if (!validExternalId(value)) {
    invalidMessage();
  }
}

function validExternalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_EXTERNAL_ID_BYTES
  );
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
    providerConversationId: row.provider_conversation_id,
    providerIdentity: row.provider_identity,
    observedAtMs: row.observed_at_ms,
    text: row.text_body
  };
}

function toThreadBinding(row: ThreadBindingRow): ThreadBinding {
  return {
    bindingId: row.binding_id,
    profileId: row.profile_id,
    conversationKey: row.conversation_key,
    scope: row.scope,
    ...(row.scope === "participant" ? { providerIdentity: row.scope_identity } : {}),
    codexThreadId: row.codex_thread_id,
    boundAtMs: row.bound_at_ms
  };
}

function toCodexInputCorrelation(row: CodexInputRow): CodexInputCorrelation {
  return {
    correlationId: row.correlation_id,
    profileId: row.profile_id,
    archiveRecordId: row.archive_record_id,
    bindingId: row.binding_id,
    codexThreadId: row.codex_thread_id,
    clientUserMessageId: row.client_user_message_id,
    state: row.state,
    ...(row.codex_turn_id ? { codexTurnId: row.codex_turn_id } : {}),
    ...(row.terminal_status ? { terminalStatus: row.terminal_status } : {}),
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
    acceptedAtMs: row.accepted_at_ms,
    updatedAtMs: row.updated_at_ms
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
