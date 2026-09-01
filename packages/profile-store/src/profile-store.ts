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
import { searchArchiveHybrid } from "./hybrid-retrieval.js";

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const SCHEMA_VERSION = 9;
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
  | "invalid_approval_request"
  | "approval_request_conflict"
  | "invalid_audit_record"
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
  readonly readOnly?: boolean;
}

export interface ArchiveCommitResult {
  readonly recordId: string;
  readonly inserted: boolean;
}

export interface ArchiveAttachmentInput {
  readonly providerAttachmentId: string;
  readonly contentType: string;
  readonly filename?: string;
  readonly sourceUrl?: string;
  readonly declaredSizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly transcript?: string;
  readonly bytesState: "metadata_only" | "pending";
}

export interface ArchiveAttachmentRecord {
  readonly attachmentRecordId: string;
  readonly messageRecordId: string;
  readonly providerAttachmentId: string;
  readonly contentType: string;
  readonly filename?: string;
  readonly sourceUrl?: string;
  readonly declaredSizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly transcript?: string;
  readonly bytesState: "metadata_only" | "pending" | "mirrored" | "unavailable";
  readonly contentSha256?: string;
  readonly mirroredSizeBytes?: number;
  readonly failureReason?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface CommitArchiveObservationInput {
  readonly message: NormalizedChannelMessage;
  readonly attachments: readonly ArchiveAttachmentInput[];
}

export interface ArchiveObservationCommitResult extends ArchiveCommitResult {
  readonly attachments: readonly ArchiveAttachmentRecord[];
}

export type SettleArchiveAttachmentInput =
  | {
      readonly attachmentRecordId: string;
      readonly outcome: "mirrored";
      readonly contentSha256: string;
      readonly mirroredSizeBytes: number;
      readonly settledAtMs: number;
    }
  | {
      readonly attachmentRecordId: string;
      readonly outcome: "unavailable";
      readonly failureReason: string;
      readonly settledAtMs: number;
    };

export interface AbandonArchiveAttachmentsInput {
  readonly failureReason: string;
  readonly settledAtMs: number;
}

export interface ChannelTransportCheckpoint {
  readonly channelAccountId: string;
  readonly provider: ChannelProvider;
  readonly sessionId: string;
  readonly sequence: number;
  readonly updatedAtMs: number;
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

export type ArchiveRetrievalSignal =
  | "exact"
  | "lexical"
  | "substring"
  | "fuzzy"
  | "structured"
  | "recency";

export interface ArchiveHybridSearch {
  readonly text?: string;
  readonly provider?: ChannelProvider;
  readonly channelAccountId?: string;
  readonly conversationKey?: string;
  readonly conversationKind?: ChannelConversationKind;
  readonly providerIdentity?: string;
  readonly observedAfterMs?: number;
  readonly observedBeforeMs?: number;
  readonly fuzzyThreshold?: number;
  readonly limit?: number;
}

export interface ArchiveHybridSearchHit extends ArchivedChannelMessage {
  /** Higher values rank first after weighted reciprocal-rank fusion. */
  readonly score: number;
  readonly matchedSignals: readonly ArchiveRetrievalSignal[];
}

export type ArchivePurgeScope =
  | { readonly kind: "profile" }
  | {
      readonly kind: "conversation_before";
      readonly conversationKey: string;
      readonly beforeMs: number;
    };

export interface ArchivePurgePreview {
  readonly profileId: string;
  readonly scope: ArchivePurgeScope;
  readonly messageCount: number;
  readonly referencedMediaBytes: number;
  readonly liveReferenceCount: number;
  readonly selectionDigest: string;
}

export interface ApplyArchivePurgeInput {
  readonly scope: ArchivePurgeScope;
  readonly expectedMessageCount: number;
  readonly expectedSelectionDigest: string;
  readonly confirmedProfileId: string;
  readonly atMs: number;
}

export interface ArchivePurgeResult extends ArchivePurgePreview {
  readonly auditRecordId: string;
  readonly unreferencedContentSha256: readonly string[];
}

export interface ProfilePurgeState {
  readonly archiveMessages: number;
  readonly archiveAttachments: number;
  readonly threadBindings: number;
  readonly codexInputCorrelations: number;
  readonly logicalResults: number;
  readonly outboxRecords: number;
  readonly approvalRequests: number;
  readonly auditRecords: number;
  readonly channelTransportCheckpoints: number;
  readonly liveWorkCount: number;
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
    readonly providerReplyParticipantId?: string;
    readonly providerReplyText?: string;
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

export type ApprovalOperationKind = "command_execution" | "file_change";
export type ApprovalRequestState = "pending" | "responded" | "cancelled" | "expired" | "failed";
export type ApprovalPresentationState = "pending" | "accepted" | "ambiguous" | "rejected";

export interface CommitApprovalRequestInput {
  readonly approvalToken: string;
  readonly operationKind: ApprovalOperationKind;
  readonly codexThreadId: string;
  readonly codexTurnId: string;
  readonly provider: ChannelProvider;
  readonly channelAccountId: string;
  readonly channelAccountEpochId: string;
  readonly providerIdentity: string;
  readonly target: LogicalResultInput["target"];
  readonly prompt: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface ApprovalRequestRecord {
  readonly approvalToken: string;
  readonly operationKind: ApprovalOperationKind;
  readonly codexThreadId: string;
  readonly codexTurnId: string;
  readonly channelAccountId: string;
  readonly channelAccountEpochId: string;
  readonly conversationKey: string;
  readonly providerIdentity: string;
  readonly state: ApprovalRequestState;
  readonly presentationState: ApprovalPresentationState;
  readonly decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  readonly reasonCode?: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly settledAtMs?: number;
}

export interface ApprovalRequestCommitResult {
  readonly approval: ApprovalRequestRecord;
  readonly logicalResult: LogicalResultCommitResult;
}

export interface SettleApprovalRequestInput {
  readonly approvalToken: string;
  readonly state: Exclude<ApprovalRequestState, "pending">;
  readonly decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  readonly reasonCode?: string;
  readonly settledAtMs: number;
}

export interface AbandonApprovalRequestsInput {
  readonly reasonCode: string;
  readonly settledAtMs: number;
}

export interface AuditRecord {
  readonly auditRecordId: string;
  readonly correlationId: string;
  readonly action: string;
  readonly result: string;
  readonly targetReference: string;
  readonly atMs: number;
}

export interface AppendAuditRecordInput {
  readonly correlationId: string;
  readonly action: string;
  readonly result: string;
  readonly targetReference: string;
  readonly atMs: number;
}

export interface AuditQuery {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly limit?: number;
}

export interface AuditRetentionPreview {
  readonly profileId: string;
  readonly beforeMs: number;
  readonly recordCount: number;
  readonly oldestAtMs: number | null;
  readonly newestAtMs: number | null;
  readonly selectionDigest: string;
}

export interface AuditRetentionResult extends AuditRetentionPreview {
  readonly auditRecordId: string;
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
  readonly sourceKind: "codex_turn" | "codex_input_uncertainty" | "approval_request";
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
  readonly provider_reply_participant_id: string | null;
  readonly provider_reply_text_body: string | null;
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

interface ApprovalRequestRow {
  readonly approval_token: string;
  readonly operation_kind: ApprovalOperationKind;
  readonly codex_thread_id: string;
  readonly codex_turn_id: string;
  readonly channel_account_id: string;
  readonly channel_account_epoch_id: string;
  readonly conversation_key: string;
  readonly provider_identity: string;
  readonly state: ApprovalRequestState;
  readonly presentation_state: ApprovalPresentationState;
  readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
  readonly reason_code: string | null;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly settled_at_ms: number | null;
}

interface AuditRecordRow {
  readonly audit_record_id: string;
  readonly correlation_id: string;
  readonly action: string;
  readonly result: string;
  readonly target_reference: string;
  readonly at_ms: number;
}

interface ArchiveAttachmentRow {
  readonly attachment_record_id: string;
  readonly message_record_id: string;
  readonly provider_attachment_id: string;
  readonly content_type: string;
  readonly original_filename: string | null;
  readonly source_url: string | null;
  readonly declared_size_bytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly transcript: string | null;
  readonly bytes_state: "metadata_only" | "pending" | "mirrored" | "unavailable";
  readonly content_sha256: string | null;
  readonly mirrored_size_bytes: number | null;
  readonly failure_reason: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

interface ArchivePurgeSnapshot {
  readonly recordIds: readonly string[];
  readonly content: readonly { readonly sha256: string; readonly bytes: number }[];
  readonly liveReferenceCount: number;
  readonly selectionDigest: string;
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
    if (options.readOnly && !existed) {
      throw new ProfileStoreError("invalid_store_configuration", "Read-only Profile store is missing");
    }
    assertStorePath(options.databasePath, existed);

    let database: Database.Database | undefined;
    try {
      database = new Database(options.databasePath, {
        timeout: options.busyTimeoutMs ?? 5_000,
        ...(options.readOnly ? { readonly: true, fileMustExist: true } : {})
      });
      if (process.platform !== "win32" && !existed) chmodSync(options.databasePath, 0o600);
      configureDatabase(database, options.busyTimeoutMs ?? 5_000, options.readOnly ?? false);
      requireFts5(database, options.readOnly ?? false);
      initializeOrValidateSchema(database, options.profileId);
      return new SqliteProfileStore(options.profileId, database);
    } catch (error) {
      database?.close();
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to open Profile store");
    }
  }

  public commitMessage(message: NormalizedChannelMessage): ArchiveCommitResult {
    const result = this.commitObservation({ message, attachments: [] });
    return { recordId: result.recordId, inserted: result.inserted };
  }

  public commitObservation(input: CommitArchiveObservationInput): ArchiveObservationCommitResult {
    this.#requireOpen();
    validateMessage(input.message, this.#profileId);
    validateArchiveAttachments(input.attachments);
    const recordId = randomUUID();
    try {
      const commit = this.#database.transaction(() => {
        const result = this.#database.prepare(
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
        ).run({ recordId, ...input.message });
        let committedRecordId: string = recordId;
        if (result.changes !== 1) {
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
              channelAccountEpochId: input.message.channelAccountEpochId,
              providerEventId: input.message.providerEventId
            });
          if (!existing) throw new Error("Deduplicated record was not found");
          committedRecordId = existing.record_id;
        } else {
          const insertAttachment = this.#database.prepare(
            `INSERT INTO archive_attachments (
               attachment_record_id, message_record_id, profile_id,
               provider_attachment_id, content_type, original_filename,
               source_url, declared_size_bytes, width, height, transcript,
               bytes_state, created_at_ms, updated_at_ms
             ) VALUES (
               @attachmentRecordId, @messageRecordId, @profileId,
               @providerAttachmentId, @contentType, @filename,
               @sourceUrl, @declaredSizeBytes, @width, @height, @transcript,
               @bytesState, @createdAtMs, @createdAtMs
             )`
          );
          for (const attachment of input.attachments) {
            insertAttachment.run({
              attachmentRecordId: randomUUID(),
              messageRecordId: committedRecordId,
              profileId: this.#profileId,
              filename: attachment.filename ?? null,
              sourceUrl: attachment.sourceUrl ?? null,
              declaredSizeBytes: attachment.declaredSizeBytes ?? null,
              width: attachment.width ?? null,
              height: attachment.height ?? null,
              transcript: attachment.transcript ?? null,
              createdAtMs: input.message.observedAtMs,
              ...attachment
            });
          }
        }
        return {
          recordId: committedRecordId,
          inserted: result.changes === 1,
          attachments: this.#archiveAttachmentsForMessage(committedRecordId)
        };
      });
      return commit.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to commit Channel observation");
    }
  }

  public archiveAttachments(messageRecordId: string): readonly ArchiveAttachmentRecord[] {
    this.#requireOpen();
    validateExternalId(messageRecordId, "messageRecordId");
    return this.#archiveAttachmentsForMessage(messageRecordId);
  }

  public settleArchiveAttachment(input: SettleArchiveAttachmentInput): ArchiveAttachmentRecord {
    this.#requireOpen();
    validateAttachmentSettlement(input);
    try {
      const result = this.#database.prepare(
        `UPDATE archive_attachments
            SET bytes_state = @outcome,
                content_sha256 = @contentSha256,
                mirrored_size_bytes = @mirroredSizeBytes,
                failure_reason = @failureReason,
                updated_at_ms = @settledAtMs
          WHERE profile_id = @profileId
            AND attachment_record_id = @attachmentRecordId
            AND bytes_state = 'pending'`
      ).run({
        profileId: this.#profileId,
        contentSha256: input.outcome === "mirrored" ? input.contentSha256 : null,
        mirroredSizeBytes: input.outcome === "mirrored" ? input.mirroredSizeBytes : null,
        failureReason: input.outcome === "unavailable" ? input.failureReason : null,
        ...input
      });
      const record = this.#database.prepare<
        { profileId: string; attachmentRecordId: string },
        ArchiveAttachmentRow
      >(
        `SELECT * FROM archive_attachments
          WHERE profile_id = @profileId AND attachment_record_id = @attachmentRecordId`
      ).get({ profileId: this.#profileId, attachmentRecordId: input.attachmentRecordId });
      if (!record) throw new ProfileStoreError("invalid_channel_message", "Attachment is unknown");
      if (result.changes !== 1 && record.bytes_state !== input.outcome) {
        throw new ProfileStoreError("invalid_channel_message", "Attachment is already settled");
      }
      return toArchiveAttachment(record);
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to settle archived attachment");
    }
  }

  public mirroredMediaBytes(): number {
    this.#requireOpen();
    const row = this.#database.prepare<{ profileId: string }, { bytes: number }>(
      `SELECT coalesce(sum(mirrored_size_bytes), 0) AS bytes
         FROM archive_attachments
        WHERE profile_id = @profileId AND bytes_state = 'mirrored'`
    ).get({ profileId: this.#profileId });
    return row?.bytes ?? 0;
  }

  public abandonPendingArchiveAttachments(input: AbandonArchiveAttachmentsInput): number {
    this.#requireOpen();
    if (!validExternalId(input.failureReason) || !validTimestamp(input.settledAtMs)) {
      throw new ProfileStoreError("invalid_channel_message", "Attachment abandonment is invalid");
    }
    try {
      return this.#database.prepare(
        `UPDATE archive_attachments
            SET bytes_state = 'unavailable',
                failure_reason = @failureReason,
                updated_at_ms = @settledAtMs
          WHERE profile_id = @profileId
            AND bytes_state = 'pending'`
      ).run({ profileId: this.#profileId, ...input }).changes;
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to abandon pending attachments");
    }
  }

  #archiveAttachmentsForMessage(messageRecordId: string): readonly ArchiveAttachmentRecord[] {
    return this.#database.prepare<{ profileId: string; messageRecordId: string }, ArchiveAttachmentRow>(
      `SELECT * FROM archive_attachments
        WHERE profile_id = @profileId AND message_record_id = @messageRecordId
        ORDER BY row_id`
    ).all({ profileId: this.#profileId, messageRecordId }).map(toArchiveAttachment);
  }

  public getChannelTransportCheckpoint(
    channelAccountId: string
  ): ChannelTransportCheckpoint | undefined {
    this.#requireOpen();
    validateExternalId(channelAccountId, "channelAccountId");
    const row = this.#database
      .prepare<
        { profileId: string; channelAccountId: string },
        {
          channel_account_id: string;
          provider: ChannelProvider;
          session_id: string;
          sequence_number: number;
          updated_at_ms: number;
        }
      >(
        `SELECT channel_account_id, provider, session_id, sequence_number, updated_at_ms
           FROM channel_transport_checkpoints
          WHERE profile_id = @profileId
            AND channel_account_id = @channelAccountId`
      )
      .get({ profileId: this.#profileId, channelAccountId });
    return row
      ? {
          channelAccountId: row.channel_account_id,
          provider: row.provider,
          sessionId: row.session_id,
          sequence: row.sequence_number,
          updatedAtMs: row.updated_at_ms
        }
      : undefined;
  }

  public putChannelTransportCheckpoint(
    checkpoint: ChannelTransportCheckpoint
  ): ChannelTransportCheckpoint {
    this.#requireOpen();
    validateChannelTransportCheckpoint(checkpoint);
    try {
      const existing = this.getChannelTransportCheckpoint(checkpoint.channelAccountId);
      if (existing && existing.provider !== checkpoint.provider) {
        throw new ProfileStoreError(
          "invalid_channel_message",
          "Channel transport checkpoint provider does not match its Channel Account"
        );
      }
      this.#database
        .prepare(
          `INSERT INTO channel_transport_checkpoints (
             profile_id, channel_account_id, provider, session_id, sequence_number, updated_at_ms
           ) VALUES (@profileId, @channelAccountId, @provider, @sessionId, @sequence, @updatedAtMs)
           ON CONFLICT(profile_id, channel_account_id) DO UPDATE SET
             provider = excluded.provider,
             session_id = excluded.session_id,
             sequence_number = excluded.sequence_number,
             updated_at_ms = excluded.updated_at_ms
           WHERE excluded.provider = channel_transport_checkpoints.provider
             AND (
               excluded.session_id <> channel_transport_checkpoints.session_id
               OR excluded.sequence_number >= channel_transport_checkpoints.sequence_number
             )`
        )
        .run({ profileId: this.#profileId, ...checkpoint });
      const persisted = this.getChannelTransportCheckpoint(checkpoint.channelAccountId);
      if (!persisted) throw new Error("Channel transport checkpoint was not persisted");
      return persisted;
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to persist Channel transport checkpoint");
    }
  }

  public clearChannelTransportCheckpoint(channelAccountId: string): void {
    this.#requireOpen();
    validateExternalId(channelAccountId, "channelAccountId");
    try {
      this.#database
        .prepare(
          `DELETE FROM channel_transport_checkpoints
            WHERE profile_id = @profileId AND channel_account_id = @channelAccountId`
        )
        .run({ profileId: this.#profileId, channelAccountId });
    } catch {
      throw new ProfileStoreError("storage_failure", "Unable to clear Channel transport checkpoint");
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

  public searchHybrid(query: ArchiveHybridSearch): readonly ArchiveHybridSearchHit[] {
    this.#requireOpen();
    return searchArchiveHybrid(this.#database, this.#profileId, query);
  }

  public previewArchivePurge(scope: ArchivePurgeScope): ArchivePurgePreview {
    this.#requireOpen();
    validateArchivePurgeScope(scope);
    const snapshot = this.#archivePurgeSnapshot(scope);
    return {
      profileId: this.#profileId,
      scope,
      messageCount: snapshot.recordIds.length,
      referencedMediaBytes: snapshot.content.reduce((total, item) => total + item.bytes, 0),
      liveReferenceCount: snapshot.liveReferenceCount,
      selectionDigest: snapshot.selectionDigest
    };
  }

  public applyArchivePurge(input: ApplyArchivePurgeInput): ArchivePurgeResult {
    this.#requireOpen();
    validateArchivePurgeScope(input.scope);
    if (
      input.confirmedProfileId !== this.#profileId ||
      !Number.isSafeInteger(input.expectedMessageCount) ||
      input.expectedMessageCount < 0 ||
      !/^[a-f0-9]{64}$/.test(input.expectedSelectionDigest) ||
      !Number.isSafeInteger(input.atMs) ||
      input.atMs < 0
    ) {
      throw new ProfileStoreError("invalid_store_configuration", "Archive purge confirmation is invalid");
    }
    try {
      const purge = this.#database.transaction(() => {
        const snapshot = this.#archivePurgeSnapshot(input.scope);
        if (
          snapshot.recordIds.length !== input.expectedMessageCount ||
          snapshot.selectionDigest !== input.expectedSelectionDigest
        ) {
          throw new ProfileStoreError("invalid_store_configuration", "Archive purge selection changed");
        }
        if (snapshot.liveReferenceCount !== 0) {
          throw new ProfileStoreError("invalid_store_configuration", "Archive purge has live references");
        }
        const deleteRecord = this.#database.prepare(
          "DELETE FROM message_archive WHERE profile_id = ? AND record_id = ?"
        );
        for (const recordId of snapshot.recordIds) deleteRecord.run(this.#profileId, recordId);
        const unreferencedContentSha256 = snapshot.content
          .filter((item) => {
            const row = this.#database.prepare<{ sha256: string }, { count: number }>(
              `SELECT count(*) AS count FROM archive_attachments
                WHERE content_sha256 = @sha256 AND bytes_state = 'mirrored'`
            ).get({ sha256: item.sha256 });
            return (row?.count ?? 0) === 0;
          })
          .map((item) => item.sha256);
        const auditRecordId = randomUUID();
        this.#database.prepare(
          `INSERT INTO audit_records (
             audit_record_id, profile_id, correlation_id, action, result,
             target_reference, at_ms
           ) VALUES (?, ?, ?, 'archive_purge', 'succeeded', ?, ?)`
        ).run(
          auditRecordId,
          this.#profileId,
          randomUUID(),
          `${snapshot.recordIds.length}:${snapshot.selectionDigest}`,
          input.atMs
        );
        return {
          profileId: this.#profileId,
          scope: input.scope,
          messageCount: snapshot.recordIds.length,
          referencedMediaBytes: snapshot.content.reduce((total, item) => total + item.bytes, 0),
          liveReferenceCount: 0,
          selectionDigest: snapshot.selectionDigest,
          auditRecordId,
          unreferencedContentSha256
        } satisfies ArchivePurgeResult;
      });
      return purge.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to purge Message Archive");
    }
  }

  public profilePurgeState(): ProfilePurgeState {
    this.#requireOpen();
    const count = (table: string): number =>
      this.#database.prepare<{ profileId: string }, { count: number }>(
        `SELECT count(*) AS count FROM ${table} WHERE profile_id = @profileId`
      ).get({ profileId: this.#profileId })?.count ?? 0;
    const liveCorrelations = this.#database.prepare<{ profileId: string }, { count: number }>(
      `SELECT count(*) AS count FROM codex_input_correlations
        WHERE profile_id = @profileId AND state IN ('accepted', 'started', 'uncertain')`
    ).get({ profileId: this.#profileId })?.count ?? 0;
    const pendingApprovals = this.#database.prepare<{ profileId: string }, { count: number }>(
      `SELECT count(*) AS count FROM approval_requests
        WHERE profile_id = @profileId AND state = 'pending'`
    ).get({ profileId: this.#profileId })?.count ?? 0;
    const pendingOutbox = this.#database.prepare<{ profileId: string }, { count: number }>(
      `SELECT count(*) AS count FROM delivery_outbox
        WHERE profile_id = @profileId AND status IN ('pending', 'leased', 'retry_wait')`
    ).get({ profileId: this.#profileId })?.count ?? 0;
    return {
      archiveMessages: count("message_archive"),
      archiveAttachments: count("archive_attachments"),
      threadBindings: count("thread_bindings"),
      codexInputCorrelations: count("codex_input_correlations"),
      logicalResults: count("logical_results"),
      outboxRecords: count("delivery_outbox"),
      approvalRequests: count("approval_requests"),
      auditRecords: count("audit_records"),
      channelTransportCheckpoints: count("channel_transport_checkpoints"),
      liveWorkCount: liveCorrelations + pendingApprovals + pendingOutbox
    };
  }

  #archivePurgeSnapshot(scope: ArchivePurgeScope): ArchivePurgeSnapshot {
    const filter = archivePurgeFilter(scope);
    const recordIds = this.#database.prepare<
      { profileId: string; conversationKey: string | null; beforeMs: number | null },
      { record_id: string }
    >(
      `SELECT record_id FROM message_archive
        WHERE profile_id = @profileId ${filter.sql}
        ORDER BY record_id`
    ).all({ profileId: this.#profileId, ...filter.params }).map((row) => row.record_id);
    const selected = new Set(recordIds);
    const contentRows = this.#database.prepare<
      { profileId: string },
      { message_record_id: string; content_sha256: string; mirrored_size_bytes: number }
    >(
      `SELECT message_record_id, content_sha256, mirrored_size_bytes
         FROM archive_attachments
        WHERE profile_id = @profileId
          AND bytes_state = 'mirrored'
          AND content_sha256 IS NOT NULL
          AND mirrored_size_bytes IS NOT NULL`
    ).all({ profileId: this.#profileId });
    const content = new Map<string, number>();
    for (const row of contentRows) {
      if (selected.has(row.message_record_id)) content.set(row.content_sha256, row.mirrored_size_bytes);
    }
    const correlationCount = recordIds.length === 0
      ? 0
      : this.#database.prepare<{ profileId: string }, { archive_record_id: string }>(
          `SELECT archive_record_id FROM codex_input_correlations
            WHERE profile_id = @profileId AND state IN ('accepted', 'started', 'uncertain')`
        ).all({ profileId: this.#profileId }).filter((row) => selected.has(row.archive_record_id)).length;
    const conversationFilter = scope.kind === "profile"
      ? ""
      : " AND conversation_key = @conversationKey";
    const pendingApproval = this.#database.prepare<
      { profileId: string; conversationKey: string | null },
      { count: number }
    >(
      `SELECT count(*) AS count FROM approval_requests
        WHERE profile_id = @profileId AND state = 'pending'${conversationFilter}`
    ).get({
      profileId: this.#profileId,
      conversationKey: scope.kind === "conversation_before" ? scope.conversationKey : null
    })?.count ?? 0;
    const pendingOutbox = this.#database.prepare<
      { profileId: string; conversationKey: string | null },
      { count: number }
    >(
      `SELECT count(*) AS count FROM delivery_outbox
        WHERE profile_id = @profileId
          AND status IN ('pending', 'leased', 'retry_wait')${conversationFilter}`
    ).get({
      profileId: this.#profileId,
      conversationKey: scope.kind === "conversation_before" ? scope.conversationKey : null
    })?.count ?? 0;
    return {
      recordIds,
      content: [...content].map(([sha256, bytes]) => ({ sha256, bytes })),
      liveReferenceCount: correlationCount + pendingApproval + pendingOutbox,
      selectionDigest: createHash("sha256").update(JSON.stringify(recordIds)).digest("hex")
    };
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
          providerReplyEventId: archive.provider_event_id,
          ...(archive.provider === "whatsapp"
            ? {
                providerReplyParticipantId: archive.provider_identity,
                ...(archive.text_body === null ? {} : { providerReplyText: archive.text_body })
              }
            : {})
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

  /** Atomically persists one process-scoped Approval projection and its Channel delivery. */
  public commitApprovalRequest(input: CommitApprovalRequestInput): ApprovalRequestCommitResult {
    this.#requireOpen();
    validateApprovalRequest(input, this.#profileId);
    const commit = this.#database.transaction((): ApprovalRequestCommitResult => {
      const existing = this.#approvalByToken(input.approvalToken);
      if (existing) {
        if (!sameApprovalRequest(existing, input)) {
          throw new ProfileStoreError(
            "approval_request_conflict",
            "Approval token already belongs to a different request"
          );
        }
        const logical = this.#database
          .prepare<{ profileId: string; sourceId: string }, LogicalResultRow>(
            `SELECT logical_result_id, payload_digest
               FROM logical_results
              WHERE profile_id = @profileId
                AND source_kind = 'approval_request'
                AND source_id = @sourceId`
          )
          .get({ profileId: this.#profileId, sourceId: input.approvalToken });
        if (!logical) throw new Error("Approval Logical Result was not found");
        return {
          approval: existing,
          logicalResult: {
            logicalResultId: logical.logical_result_id,
            outboxRecordIds: this.#outboxIds(logical.logical_result_id),
            inserted: false
          }
        };
      }
      this.#database
        .prepare(
          `INSERT INTO approval_requests (
             approval_token, profile_id, operation_kind, codex_thread_id, codex_turn_id,
             channel_account_id, channel_account_epoch_id, conversation_key,
             provider_identity, state, presentation_state, created_at_ms, expires_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)`
        )
        .run(
          input.approvalToken,
          this.#profileId,
          input.operationKind,
          input.codexThreadId,
          input.codexTurnId,
          input.channelAccountId,
          input.channelAccountEpochId,
          input.target.conversationKey,
          input.providerIdentity,
          input.createdAtMs,
          input.expiresAtMs
        );
      const logicalResult = this.#commitDurableResult({
        profileId: this.#profileId,
        sourceKind: "approval_request",
        sourceId: input.approvalToken,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        provider: input.provider,
        channelAccountId: input.channelAccountId,
        channelAccountEpochId: input.channelAccountEpochId,
        target: input.target,
        completedAtMs: input.createdAtMs,
        segments: [{ text: input.prompt }]
      });
      this.#appendAudit(
        input.approvalToken,
        "approval_requested",
        "succeeded",
        input.approvalToken,
        input.createdAtMs
      );
      return { approval: this.#approvalByToken(input.approvalToken)!, logicalResult };
    });
    try {
      return commit.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to commit Approval Request");
    }
  }

  public settleApprovalRequest(input: SettleApprovalRequestInput): ApprovalRequestRecord {
    this.#requireOpen();
    validateApprovalSettlement(input);
    const settle = this.#database.transaction((): ApprovalRequestRecord => {
      const current = this.#approvalByToken(input.approvalToken);
      if (!current) {
        throw new ProfileStoreError("invalid_approval_request", "Approval Request was not found");
      }
      if (current.state !== "pending") {
        if (
          current.state === input.state &&
          current.decision === input.decision &&
          current.reasonCode === input.reasonCode
        ) return current;
        throw new ProfileStoreError(
          "approval_request_conflict",
          "Approval Request already has a different terminal outcome"
        );
      }
      this.#database
        .prepare(
          `UPDATE approval_requests
              SET state = @state,
                  decision = @decision,
                  reason_code = @reasonCode,
                  settled_at_ms = @settledAtMs
            WHERE profile_id = @profileId
              AND approval_token = @approvalToken`
        )
        .run({
          profileId: this.#profileId,
          approvalToken: input.approvalToken,
          state: input.state,
          decision: input.decision ?? null,
          reasonCode: input.reasonCode ?? null,
          settledAtMs: input.settledAtMs
        });
      this.#rejectApprovalOutbox(input.approvalToken, input.reasonCode ?? input.state, input.settledAtMs);
      this.#appendAudit(
        input.approvalToken,
        "approval_resolved",
        input.state,
        input.approvalToken,
        input.settledAtMs
      );
      return this.#approvalByToken(input.approvalToken)!;
    });
    try {
      return settle.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to settle Approval Request");
    }
  }

  public abandonPendingApprovalRequests(
    input: AbandonApprovalRequestsInput
  ): readonly ApprovalRequestRecord[] {
    this.#requireOpen();
    if (!validExternalId(input.reasonCode) || !validTimestamp(input.settledAtMs)) {
      throw new ProfileStoreError("invalid_approval_request", "Approval abandonment is invalid");
    }
    const abandon = this.#database.transaction(() => {
      const pending = this.#database
        .prepare<{ profileId: string }, ApprovalRequestRow>(
          "SELECT * FROM approval_requests WHERE profile_id = @profileId AND state = 'pending'"
        )
        .all({ profileId: this.#profileId });
      for (const row of pending) {
        this.#database
          .prepare(
            `UPDATE approval_requests
                SET state = 'cancelled', reason_code = @reasonCode, settled_at_ms = @settledAtMs
              WHERE approval_token = @approvalToken`
          )
          .run({
            approvalToken: row.approval_token,
            reasonCode: input.reasonCode,
            settledAtMs: input.settledAtMs
          });
        this.#rejectApprovalOutbox(row.approval_token, input.reasonCode, input.settledAtMs);
        this.#appendAudit(
          row.approval_token,
          "approval_resolved",
          "cancelled",
          row.approval_token,
          input.settledAtMs
        );
      }
      return pending.map((row) => this.#approvalByToken(row.approval_token)!);
    });
    try {
      return abandon.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to abandon Approval Requests");
    }
  }

  public auditRecords(limit = DEFAULT_LIMIT): readonly AuditRecord[] {
    this.#requireOpen();
    const boundedLimit = validateLimit(limit);
    return this.#database
      .prepare<{ profileId: string; limit: number }, AuditRecordRow>(
        `SELECT audit_record_id, correlation_id, action, result, target_reference, at_ms
           FROM audit_records
          WHERE profile_id = @profileId
          ORDER BY row_id DESC
          LIMIT @limit`
      )
      .all({ profileId: this.#profileId, limit: boundedLimit })
      .map(toAuditRecord);
  }

  public queryAuditRecords(query: AuditQuery = {}): readonly AuditRecord[] {
    this.#requireOpen();
    const fromMs = query.fromMs ?? 0;
    const toMs = query.toMs ?? Number.MAX_SAFE_INTEGER;
    const limit = validateLimit(query.limit ?? DEFAULT_LIMIT);
    if (
      !Number.isSafeInteger(fromMs) ||
      !Number.isSafeInteger(toMs) ||
      fromMs < 0 ||
      toMs < fromMs
    ) throw new ProfileStoreError("invalid_audit_record", "Audit query range is invalid");
    return this.#database
      .prepare<{ profileId: string; fromMs: number; toMs: number; limit: number }, AuditRecordRow>(
        `SELECT audit_record_id, correlation_id, action, result, target_reference, at_ms
           FROM audit_records
          WHERE profile_id = @profileId
            AND at_ms >= @fromMs
            AND at_ms <= @toMs
          ORDER BY at_ms DESC, row_id DESC
          LIMIT @limit`
      )
      .all({ profileId: this.#profileId, fromMs, toMs, limit })
      .map(toAuditRecord);
  }

  public previewAuditRetention(beforeMs: number): AuditRetentionPreview {
    this.#requireOpen();
    validateRetentionTimestamp(beforeMs);
    const rows = this.#auditRetentionRows(beforeMs);
    return auditRetentionPreview(this.#profileId, beforeMs, rows);
  }

  public applyAuditRetention(input: {
    readonly beforeMs: number;
    readonly expectedRecordCount: number;
    readonly expectedSelectionDigest: string;
    readonly correlationId: string;
    readonly atMs: number;
  }): AuditRetentionResult {
    this.#requireOpen();
    validateRetentionTimestamp(input.beforeMs);
    if (
      !Number.isSafeInteger(input.expectedRecordCount) ||
      input.expectedRecordCount < 0 ||
      !/^[a-f0-9]{64}$/.test(input.expectedSelectionDigest) ||
      !validExternalId(input.correlationId) ||
      !validTimestamp(input.atMs)
    ) throw new ProfileStoreError("invalid_audit_record", "Audit retention confirmation is invalid");
    const apply = this.#database.transaction(() => {
      const rows = this.#auditRetentionRows(input.beforeMs);
      const preview = auditRetentionPreview(this.#profileId, input.beforeMs, rows);
      if (
        preview.recordCount !== input.expectedRecordCount ||
        preview.selectionDigest !== input.expectedSelectionDigest
      ) throw new ProfileStoreError("invalid_audit_record", "Audit retention selection changed");
      if (rows.length > 0) {
        const remove = this.#database.prepare("DELETE FROM audit_records WHERE audit_record_id = ?");
        for (const row of rows) remove.run(row.audit_record_id);
      }
      const targetReference = JSON.stringify({
        beforeMs: preview.beforeMs,
        recordCount: preview.recordCount,
        oldestAtMs: preview.oldestAtMs,
        newestAtMs: preview.newestAtMs,
        selectionDigest: preview.selectionDigest
      });
      this.#appendAudit(
        input.correlationId,
        "audit_retention_cleanup",
        "succeeded",
        targetReference,
        input.atMs
      );
      return { ...preview, auditRecordId: this.auditRecords(1)[0]!.auditRecordId };
    });
    try {
      return apply.immediate();
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to apply Audit retention");
    }
  }

  public appendAuditRecord(input: AppendAuditRecordInput): AuditRecord {
    this.#requireOpen();
    if (
      !validExternalId(input.correlationId) ||
      !validExternalId(input.action) ||
      !validExternalId(input.result) ||
      !validExternalId(input.targetReference) ||
      !validTimestamp(input.atMs)
    ) {
      throw new ProfileStoreError("invalid_audit_record", "Audit Record is invalid");
    }
    try {
      this.#appendAudit(
        input.correlationId,
        input.action,
        input.result,
        input.targetReference,
        input.atMs
      );
      return this.auditRecords(1)[0]!;
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError("storage_failure", "Unable to append Audit Record");
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
           provider_reply_participant_id,
           provider_reply_text_body,
           provider_reply_sequence,
           text_body,
           status,
           attempt_count,
           next_attempt_at_ms,
           created_at_ms,
           updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
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
        input.target.providerReplyParticipantId ?? null,
        input.target.providerReplyText ?? null,
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
                  current.provider_reply_participant_id,
                  current.provider_reply_text_body,
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
        this.#updateApprovalPresentation(
          row.logical_result_id,
          "accepted",
          "accepted",
          settlement.acceptedAtMs
        );
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
        this.#updateApprovalPresentation(
          row.logical_result_id,
          "ambiguous",
          settlement.outcome,
          settlement.settledAtMs
        );
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
      this.#updateApprovalPresentation(
        row.logical_result_id,
        "rejected",
        "rejected",
        settlement.settledAtMs
      );
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
    return this.#outboxCounts();
  }

  public outboxCountsForChannelAccount(channelAccountId: string): OutboxCounts {
    validateExternalId(channelAccountId, "channelAccountId");
    return this.#outboxCounts(channelAccountId);
  }

  #outboxCounts(channelAccountId?: string): OutboxCounts {
    this.#requireOpen();
    const rows = this.#database
      .prepare<{ profileId: string; channelAccountId?: string }, OutboxCountRow>(
        `SELECT status, count(*) AS count
           FROM delivery_outbox
          WHERE profile_id = @profileId
            ${channelAccountId === undefined ? "" : "AND channel_account_id = @channelAccountId"}
          GROUP BY status`
      )
      .all({ profileId: this.#profileId, ...(channelAccountId ? { channelAccountId } : {}) });
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

  #approvalByToken(approvalToken: string): ApprovalRequestRecord | undefined {
    const row = this.#database
      .prepare<{ profileId: string; approvalToken: string }, ApprovalRequestRow>(
        `SELECT * FROM approval_requests
          WHERE profile_id = @profileId AND approval_token = @approvalToken`
      )
      .get({ profileId: this.#profileId, approvalToken });
    return row ? toApprovalRequest(row) : undefined;
  }

  #rejectApprovalOutbox(approvalToken: string, reasonCode: string, atMs: number): void {
    this.#database
      .prepare(
        `UPDATE delivery_outbox
            SET status = 'rejected', lease_token = NULL, lease_expires_at_ms = NULL,
                last_outcome = 'rejected', last_reason_code = @reasonCode, updated_at_ms = @atMs
          WHERE logical_result_id = (
            SELECT logical_result_id FROM logical_results
             WHERE profile_id = @profileId
               AND source_kind = 'approval_request'
               AND source_id = @approvalToken
          )
            AND status IN ('pending', 'leased', 'retry_wait')`
      )
      .run({ profileId: this.#profileId, approvalToken, reasonCode, atMs });
  }

  #updateApprovalPresentation(
    logicalResultId: string,
    presentationState: ApprovalPresentationState,
    result: string,
    atMs: number
  ): void {
    const source = this.#database
      .prepare<{ logicalResultId: string; profileId: string }, { source_id: string }>(
        `SELECT source_id FROM logical_results
          WHERE logical_result_id = @logicalResultId
            AND profile_id = @profileId
            AND source_kind = 'approval_request'`
      )
      .get({ logicalResultId, profileId: this.#profileId });
    if (!source) return;
    this.#database
      .prepare(
        `UPDATE approval_requests
            SET presentation_state = @presentationState
          WHERE profile_id = @profileId
            AND approval_token = @approvalToken
            AND state = 'pending'`
      )
      .run({
        presentationState,
        profileId: this.#profileId,
        approvalToken: source.source_id
      });
    this.#appendAudit(
      source.source_id,
      "approval_presentation",
      result,
      source.source_id,
      atMs
    );
  }

  #appendAudit(
    correlationId: string,
    action: string,
    result: string,
    targetReference: string,
    atMs: number
  ): void {
    this.#database
      .prepare(
        `INSERT INTO audit_records (
           audit_record_id, profile_id, correlation_id, action, result, target_reference, at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), this.#profileId, correlationId, action, result, targetReference, atMs);
  }

  #auditRetentionRows(beforeMs: number): readonly AuditRecordRow[] {
    return this.#database
      .prepare<{ profileId: string; beforeMs: number }, AuditRecordRow>(
        `SELECT audit_record_id, correlation_id, action, result, target_reference, at_ms
           FROM audit_records
          WHERE profile_id = @profileId
            AND at_ms < @beforeMs
            AND action <> 'audit_retention_cleanup'
          ORDER BY at_ms ASC, row_id ASC`
      )
      .all({ profileId: this.#profileId, beforeMs });
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
      (!Number.isInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0)) ||
    (options.readOnly !== undefined && typeof options.readOnly !== "boolean")
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

function configureDatabase(
  database: Database.Database,
  busyTimeoutMs: number,
  readOnly: boolean
): void {
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  database.pragma("foreign_keys = ON");
  if (readOnly) database.pragma("query_only = ON");
  else database.pragma("synchronous = FULL");
  const mode = String(
    database.pragma(readOnly ? "journal_mode" : "journal_mode = WAL", { simple: true })
  ).toLowerCase();
  if (mode !== "wal") {
    throw new ProfileStoreError("storage_failure", "Profile store could not enable WAL mode");
  }
}

function requireFts5(database: Database.Database, readOnly: boolean): void {
  try {
    if (readOnly) database.prepare("SELECT rowid FROM message_archive_fts LIMIT 0").all();
    else database.exec(
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
        provider_reply_participant_id TEXT,
        provider_reply_text_body TEXT,
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
    database
      .prepare("INSERT INTO profile_metadata (singleton, profile_id) VALUES (1, ?)")
      .run(profileId);
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  initialize.immediate();
}

function validateChannelTransportCheckpoint(checkpoint: ChannelTransportCheckpoint): void {
  if (
    !validExternalId(checkpoint.channelAccountId) ||
    (checkpoint.provider !== "qq" && checkpoint.provider !== "whatsapp") ||
    !validExternalId(checkpoint.sessionId) ||
    !Number.isSafeInteger(checkpoint.sequence) ||
    checkpoint.sequence < 0 ||
    !Number.isSafeInteger(checkpoint.updatedAtMs) ||
    checkpoint.updatedAtMs < 0
  ) {
    throw new ProfileStoreError("invalid_channel_message", "Channel transport checkpoint is invalid");
  }
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

function validateArchiveAttachments(attachments: readonly ArchiveAttachmentInput[]): void {
  const ids = new Set<string>();
  if (attachments.length > 100) invalidMessage();
  for (const attachment of attachments) {
    validateExternalId(attachment.providerAttachmentId, "providerAttachmentId");
    if (
      ids.has(attachment.providerAttachmentId) ||
      !attachment.contentType.trim() ||
      Buffer.byteLength(attachment.contentType, "utf8") > 1024 ||
      (attachment.filename !== undefined && Buffer.byteLength(attachment.filename, "utf8") > 8192) ||
      (attachment.sourceUrl !== undefined && Buffer.byteLength(attachment.sourceUrl, "utf8") > 65536) ||
      (attachment.transcript !== undefined && Buffer.byteLength(attachment.transcript, "utf8") > MAX_TEXT_BYTES) ||
      (attachment.bytesState !== "metadata_only" && attachment.bytesState !== "pending") ||
      !validOptionalNonnegativeInteger(attachment.declaredSizeBytes) ||
      !validOptionalNonnegativeInteger(attachment.width) ||
      !validOptionalNonnegativeInteger(attachment.height)
    ) invalidMessage();
    ids.add(attachment.providerAttachmentId);
  }
}

function validateArchivePurgeScope(scope: ArchivePurgeScope): void {
  if (scope.kind === "profile") return;
  if (
    scope.kind !== "conversation_before" ||
    !Number.isSafeInteger(scope.beforeMs) ||
    scope.beforeMs < 0
  ) {
    throw new ProfileStoreError("invalid_store_configuration", "Archive purge scope is invalid");
  }
  validateExternalId(scope.conversationKey, "conversationKey");
}

function archivePurgeFilter(scope: ArchivePurgeScope): {
  readonly sql: string;
  readonly params: { readonly conversationKey: string | null; readonly beforeMs: number | null };
} {
  return scope.kind === "profile"
    ? { sql: "", params: { conversationKey: null, beforeMs: null } }
    : {
        sql: "AND conversation_key = @conversationKey AND observed_at_ms < @beforeMs",
        params: { conversationKey: scope.conversationKey, beforeMs: scope.beforeMs }
      };
}

function validateAttachmentSettlement(input: SettleArchiveAttachmentInput): void {
  validateExternalId(input.attachmentRecordId, "attachmentRecordId");
  if (!Number.isSafeInteger(input.settledAtMs) || input.settledAtMs < 0) invalidMessage();
  if (input.outcome === "mirrored") {
    if (
      !/^[a-f0-9]{64}$/.test(input.contentSha256) ||
      !Number.isSafeInteger(input.mirroredSizeBytes) ||
      input.mirroredSizeBytes < 0
    ) invalidMessage();
  } else if (
    !input.failureReason.trim() ||
    Buffer.byteLength(input.failureReason, "utf8") > 1024
  ) {
    invalidMessage();
  }
}

function validOptionalNonnegativeInteger(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function toArchiveAttachment(row: ArchiveAttachmentRow): ArchiveAttachmentRecord {
  return {
    attachmentRecordId: row.attachment_record_id,
    messageRecordId: row.message_record_id,
    providerAttachmentId: row.provider_attachment_id,
    contentType: row.content_type,
    ...(row.original_filename === null ? {} : { filename: row.original_filename }),
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    ...(row.declared_size_bytes === null ? {} : { declaredSizeBytes: row.declared_size_bytes }),
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    ...(row.transcript === null ? {} : { transcript: row.transcript }),
    bytesState: row.bytes_state,
    ...(row.content_sha256 === null ? {} : { contentSha256: row.content_sha256 }),
    ...(row.mirrored_size_bytes === null ? {} : { mirroredSizeBytes: row.mirrored_size_bytes }),
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  };
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
      validExternalId(input.target.providerReplyEventId)) &&
    validReplyQuote(input.provider, input.target);
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

function validateApprovalRequest(input: CommitApprovalRequestInput, profileId: string): void {
  const valid =
    profileId.length > 0 &&
    validExternalId(input.approvalToken) &&
    (input.operationKind === "command_execution" || input.operationKind === "file_change") &&
    validExternalId(input.codexThreadId) &&
    validExternalId(input.codexTurnId) &&
    (input.provider === "qq" || input.provider === "whatsapp") &&
    validExternalId(input.channelAccountId) &&
    validExternalId(input.channelAccountEpochId) &&
    validExternalId(input.providerIdentity) &&
    validExternalId(input.target.conversationKey) &&
    (input.target.conversationKind === "private" || input.target.conversationKind === "group") &&
    validExternalId(input.target.providerConversationId) &&
    (input.target.providerReplyEventId === undefined ||
      validExternalId(input.target.providerReplyEventId)) &&
    validReplyQuote(input.provider, input.target) &&
    typeof input.prompt === "string" &&
    input.prompt.length > 0 &&
    Buffer.byteLength(input.prompt, "utf8") <= MAX_TEXT_BYTES &&
    validTimestamp(input.createdAtMs) &&
    validTimestamp(input.expiresAtMs) &&
    input.expiresAtMs > input.createdAtMs;
  if (!valid) {
    throw new ProfileStoreError("invalid_approval_request", "Approval Request is invalid");
  }
}

function validReplyQuote(
  provider: ChannelProvider,
  target: {
    readonly providerReplyEventId?: string;
    readonly providerReplyParticipantId?: string;
    readonly providerReplyText?: string;
  }
): boolean {
  const hasParticipant = target.providerReplyParticipantId !== undefined;
  const hasText = target.providerReplyText !== undefined;
  if (!hasParticipant && !hasText) return true;
  return provider === "whatsapp" &&
    validExternalId(target.providerReplyEventId) &&
    validExternalId(target.providerReplyParticipantId) &&
    typeof target.providerReplyText === "string" &&
    Buffer.byteLength(target.providerReplyText, "utf8") <= MAX_TEXT_BYTES;
}

function validateApprovalSettlement(input: SettleApprovalRequestInput): void {
  const decisionValid =
    input.decision === undefined ||
    input.decision === "accept" ||
    input.decision === "acceptForSession" ||
    input.decision === "decline" ||
    input.decision === "cancel";
  const valid =
    validExternalId(input.approvalToken) &&
    (input.state === "responded" ||
      input.state === "cancelled" ||
      input.state === "expired" ||
      input.state === "failed") &&
    decisionValid &&
    (input.state === "responded" ? input.decision !== undefined : input.decision === undefined) &&
    (input.reasonCode === undefined || /^[a-z][a-z0-9_]{0,127}$/u.test(input.reasonCode)) &&
    validTimestamp(input.settledAtMs);
  if (!valid) {
    throw new ProfileStoreError("invalid_approval_request", "Approval settlement is invalid");
  }
}

function sameApprovalRequest(
  current: ApprovalRequestRecord,
  input: CommitApprovalRequestInput
): boolean {
  return current.operationKind === input.operationKind &&
    current.codexThreadId === input.codexThreadId &&
    current.codexTurnId === input.codexTurnId &&
    current.channelAccountId === input.channelAccountId &&
    current.channelAccountEpochId === input.channelAccountEpochId &&
    current.conversationKey === input.target.conversationKey &&
    current.providerIdentity === input.providerIdentity &&
    current.createdAtMs === input.createdAtMs &&
    current.expiresAtMs === input.expiresAtMs;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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
    input.target.providerReplyParticipantId ?? null,
    input.target.providerReplyText ?? null,
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
        : {}),
      ...(row.provider_reply_participant_id
        ? { providerReplyParticipantId: row.provider_reply_participant_id }
        : {}),
      ...(row.provider_reply_text_body !== null
        ? { providerReplyText: row.provider_reply_text_body }
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

function validateRetentionTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProfileStoreError("invalid_audit_record", "Audit retention timestamp is invalid");
  }
}

function auditRetentionPreview(
  profileId: string,
  beforeMs: number,
  rows: readonly AuditRecordRow[]
): AuditRetentionPreview {
  return {
    profileId,
    beforeMs,
    recordCount: rows.length,
    oldestAtMs: rows[0]?.at_ms ?? null,
    newestAtMs: rows.at(-1)?.at_ms ?? null,
    selectionDigest: createHash("sha256")
      .update(JSON.stringify(rows.map((row) => [
        row.audit_record_id,
        row.correlation_id,
        row.action,
        row.result,
        row.target_reference,
        row.at_ms
      ])))
      .digest("hex")
  };
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

function toApprovalRequest(row: ApprovalRequestRow): ApprovalRequestRecord {
  return {
    approvalToken: row.approval_token,
    operationKind: row.operation_kind,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    channelAccountId: row.channel_account_id,
    channelAccountEpochId: row.channel_account_epoch_id,
    conversationKey: row.conversation_key,
    providerIdentity: row.provider_identity,
    state: row.state,
    presentationState: row.presentation_state,
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    ...(row.settled_at_ms !== null ? { settledAtMs: row.settled_at_ms } : {})
  };
}

function toAuditRecord(row: AuditRecordRow): AuditRecord {
  return {
    auditRecordId: row.audit_record_id,
    correlationId: row.correlation_id,
    action: row.action,
    result: row.result,
    targetReference: row.target_reference,
    atMs: row.at_ms
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
