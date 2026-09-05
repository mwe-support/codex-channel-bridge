import { Worker } from "node:worker_threads";

import type {
  CodexInputAcceptance,
  CodexInputCorrelation,
  ThreadBinding,
  ThreadBindingKey
} from "@codex-channel-bridge/core";

import {
  ProfileStoreError,
  type AnswerStreamRecord,
  type BeginAnswerStreamInput,
  type AbandonArchiveAttachmentsInput,
  type ArchiveAttachmentRecord,
  type ArchiveObservationCommitResult,
  type ArchiveHybridSearch,
  type ArchiveHybridSearchHit,
  type ArchivePurgePreview,
  type ArchivePurgeResult,
  type ArchivePurgeScope,
  type ApplyArchivePurgeInput,
  type AppendAuditRecordInput,
  type ArchivedChannelMessage,
  type AbandonApprovalRequestsInput,
  type ApprovalRequestCommitResult,
  type ApprovalRequestRecord,
  type AuditRecord,
  type ClaimOutboxOptions,
  type ChannelTransportCheckpoint,
  type CodexInputUncertaintyCommitResult,
  type CodexTurnResultCommitResult,
  type CommitCodexInputUncertaintyInput,
  type CommitCodexTurnResultInput,
  type CommitApprovalRequestInput,
  type CommitArchiveObservationInput,
  type CodexInputCommitResult,
  type CodexInputTransition,
  type CreateThreadBindingInput,
  type OpenProfileStoreOptions,
  type OutboxCounts,
  type OutboxDeliveryLease,
  type OutboxSettlement,
  type OutboxSettlementResult,
  type ProfileStoreReason,
  type ProfilePurgeState,
  type SettleApprovalRequestInput,
  type SettleArchiveAttachmentInput,
  type ThreadBindingCommitResult
} from "./profile-store.js";

interface StorageOperationArguments {
  readonly beginAnswerStream: readonly [BeginAnswerStreamInput];
  readonly getAnswerStream: readonly [string];
  readonly putAnswerStream: readonly [AnswerStreamRecord];
  readonly commitObservation: readonly [CommitArchiveObservationInput];
  readonly settleArchiveAttachment: readonly [SettleArchiveAttachmentInput];
  readonly mirroredMediaBytes: readonly [];
  readonly abandonPendingArchiveAttachments: readonly [AbandonArchiveAttachmentsInput];
  readonly getChannelTransportCheckpoint: readonly [string];
  readonly putChannelTransportCheckpoint: readonly [ChannelTransportCheckpoint];
  readonly clearChannelTransportCheckpoint: readonly [string];
  readonly recentMessages: readonly [string, number?];
  readonly searchHybrid: readonly [ArchiveHybridSearch];
  readonly previewArchivePurge: readonly [ArchivePurgeScope];
  readonly applyArchivePurge: readonly [ApplyArchivePurgeInput];
  readonly profilePurgeState: readonly [];
  readonly getThreadBinding: readonly [ThreadBindingKey];
  readonly createThreadBinding: readonly [CreateThreadBindingInput];
  readonly replaceThreadBinding: readonly [CreateThreadBindingInput];
  readonly detachThreadBinding: readonly [ThreadBindingKey];
  readonly acceptCodexInput: readonly [CodexInputAcceptance];
  readonly transitionCodexInput: readonly [CodexInputTransition];
  readonly nonterminalCodexInputs: readonly [];
  readonly commitCodexInputUncertainty: readonly [CommitCodexInputUncertaintyInput];
  readonly commitCodexTurnResult: readonly [CommitCodexTurnResultInput];
  readonly commitApprovalRequest: readonly [CommitApprovalRequestInput];
  readonly settleApprovalRequest: readonly [SettleApprovalRequestInput];
  readonly abandonPendingApprovalRequests: readonly [AbandonApprovalRequestsInput];
  readonly auditRecords: readonly [number?];
  readonly appendAuditRecord: readonly [AppendAuditRecordInput];
  readonly claimOutbox: readonly [ClaimOutboxOptions];
  readonly settleOutbox: readonly [OutboxSettlement];
  readonly outboxCounts: readonly [];
  readonly outboxCountsForChannelAccount: readonly [string];
  readonly close: readonly [];
}

interface StorageOperationResults {
  readonly beginAnswerStream: AnswerStreamRecord;
  readonly getAnswerStream: AnswerStreamRecord | undefined;
  readonly putAnswerStream: void;
  readonly commitObservation: ArchiveObservationCommitResult;
  readonly settleArchiveAttachment: ArchiveAttachmentRecord;
  readonly mirroredMediaBytes: number;
  readonly abandonPendingArchiveAttachments: number;
  readonly getChannelTransportCheckpoint: ChannelTransportCheckpoint | undefined;
  readonly putChannelTransportCheckpoint: ChannelTransportCheckpoint;
  readonly clearChannelTransportCheckpoint: void;
  readonly recentMessages: readonly ArchivedChannelMessage[];
  readonly searchHybrid: readonly ArchiveHybridSearchHit[];
  readonly previewArchivePurge: ArchivePurgePreview;
  readonly applyArchivePurge: ArchivePurgeResult;
  readonly profilePurgeState: ProfilePurgeState;
  readonly getThreadBinding: ThreadBinding | undefined;
  readonly createThreadBinding: ThreadBindingCommitResult;
  readonly replaceThreadBinding: ThreadBindingCommitResult;
  readonly detachThreadBinding: ThreadBinding | undefined;
  readonly acceptCodexInput: CodexInputCommitResult;
  readonly transitionCodexInput: CodexInputCorrelation;
  readonly nonterminalCodexInputs: readonly CodexInputCorrelation[];
  readonly commitCodexInputUncertainty: CodexInputUncertaintyCommitResult;
  readonly commitCodexTurnResult: CodexTurnResultCommitResult;
  readonly commitApprovalRequest: ApprovalRequestCommitResult;
  readonly settleApprovalRequest: ApprovalRequestRecord;
  readonly abandonPendingApprovalRequests: readonly ApprovalRequestRecord[];
  readonly auditRecords: readonly AuditRecord[];
  readonly appendAuditRecord: AuditRecord;
  readonly claimOutbox: readonly OutboxDeliveryLease[];
  readonly settleOutbox: OutboxSettlementResult;
  readonly outboxCounts: OutboxCounts;
  readonly outboxCountsForChannelAccount: OutboxCounts;
  readonly close: null;
}

type StorageOperationName = keyof StorageOperationArguments;
type StorageOperation = {
  readonly [Name in StorageOperationName]: {
    readonly name: Name;
    readonly args: StorageOperationArguments[Name];
  }
}[StorageOperationName];

interface StorageRequest {
  readonly type: "request";
  readonly id: number;
  readonly operation: StorageOperation;
}

interface SerializedStoreError {
  readonly reason: ProfileStoreReason;
  readonly message: string;
}

type StorageResponse =
  | { readonly type: "ready" }
  | { readonly type: "response"; readonly id: number; readonly result: unknown }
  | { readonly type: "error"; readonly id: number; readonly error: SerializedStoreError }
  | { readonly type: "fatal"; readonly error: SerializedStoreError };

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Profile-owned asynchronous storage interface. All SQLite work runs in one
 * dedicated Worker thread, so Channel adapters never execute synchronous
 * database calls on the Profile worker event loop.
 */
export class ProfileStore {
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #nextRequestId = 1;
  #readySettled = false;
  #closing = false;
  #closed = false;

  private constructor(options: OpenProfileStoreOptions) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#worker = new Worker(new URL("./storage-worker.js", import.meta.url), {
      workerData: options
    });
    this.#worker.on("message", (message: unknown) => this.#handleMessage(message));
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.on("exit", (code) => {
      if (!this.#closed && !this.#closing) {
        this.#fail(
          new ProfileStoreError(
            "storage_failure",
            `Profile storage worker exited unexpectedly (${code})`
          )
        );
      }
    });
  }

  public static async open(options: OpenProfileStoreOptions): Promise<ProfileStore> {
    const store = new ProfileStore(options);
    await store.#ready;
    return store;
  }

  public commitObservation(
    input: CommitArchiveObservationInput
  ): Promise<ArchiveObservationCommitResult> {
    return this.#request("commitObservation", input);
  }

  public settleArchiveAttachment(
    input: SettleArchiveAttachmentInput
  ): Promise<ArchiveAttachmentRecord> {
    return this.#request("settleArchiveAttachment", input);
  }

  public mirroredMediaBytes(): Promise<number> {
    return this.#request("mirroredMediaBytes");
  }

  public abandonPendingArchiveAttachments(input: AbandonArchiveAttachmentsInput): Promise<number> {
    return this.#request("abandonPendingArchiveAttachments", input);
  }

  public beginAnswerStream(input: BeginAnswerStreamInput): Promise<AnswerStreamRecord> {
    return this.#request("beginAnswerStream", input);
  }

  public getAnswerStream(archiveRecordId: string): Promise<AnswerStreamRecord | undefined> {
    return this.#request("getAnswerStream", archiveRecordId);
  }

  public putAnswerStream(record: AnswerStreamRecord): Promise<void> {
    return this.#request("putAnswerStream", record);
  }

  public getChannelTransportCheckpoint(
    channelAccountId: string
  ): Promise<ChannelTransportCheckpoint | undefined> {
    return this.#request("getChannelTransportCheckpoint", channelAccountId);
  }

  public putChannelTransportCheckpoint(
    checkpoint: ChannelTransportCheckpoint
  ): Promise<ChannelTransportCheckpoint> {
    return this.#request("putChannelTransportCheckpoint", checkpoint);
  }

  public clearChannelTransportCheckpoint(channelAccountId: string): Promise<void> {
    return this.#request("clearChannelTransportCheckpoint", channelAccountId);
  }

  public recentMessages(
    conversationKey: string,
    limit?: number
  ): Promise<readonly ArchivedChannelMessage[]> {
    return this.#request("recentMessages", conversationKey, limit);
  }

  public searchHybrid(query: ArchiveHybridSearch): Promise<readonly ArchiveHybridSearchHit[]> {
    return this.#request("searchHybrid", query);
  }

  public previewArchivePurge(scope: ArchivePurgeScope): Promise<ArchivePurgePreview> {
    return this.#request("previewArchivePurge", scope);
  }

  public applyArchivePurge(input: ApplyArchivePurgeInput): Promise<ArchivePurgeResult> {
    return this.#request("applyArchivePurge", input);
  }

  public profilePurgeState(): Promise<ProfilePurgeState> {
    return this.#request("profilePurgeState");
  }

  public getThreadBinding(key: ThreadBindingKey): Promise<ThreadBinding | undefined> {
    return this.#request("getThreadBinding", key);
  }

  public createThreadBinding(input: CreateThreadBindingInput): Promise<ThreadBindingCommitResult> {
    return this.#request("createThreadBinding", input);
  }

  public replaceThreadBinding(input: CreateThreadBindingInput): Promise<ThreadBindingCommitResult> {
    return this.#request("replaceThreadBinding", input);
  }

  public detachThreadBinding(key: ThreadBindingKey): Promise<ThreadBinding | undefined> {
    return this.#request("detachThreadBinding", key);
  }

  public acceptCodexInput(input: CodexInputAcceptance): Promise<CodexInputCommitResult> {
    return this.#request("acceptCodexInput", input);
  }

  public transitionCodexInput(transition: CodexInputTransition): Promise<CodexInputCorrelation> {
    return this.#request("transitionCodexInput", transition);
  }

  public nonterminalCodexInputs(): Promise<readonly CodexInputCorrelation[]> {
    return this.#request("nonterminalCodexInputs");
  }

  public commitCodexInputUncertainty(
    input: CommitCodexInputUncertaintyInput
  ): Promise<CodexInputUncertaintyCommitResult> {
    return this.#request("commitCodexInputUncertainty", input);
  }

  public commitCodexTurnResult(
    input: CommitCodexTurnResultInput
  ): Promise<CodexTurnResultCommitResult> {
    return this.#request("commitCodexTurnResult", input);
  }

  public commitApprovalRequest(
    input: CommitApprovalRequestInput
  ): Promise<ApprovalRequestCommitResult> {
    return this.#request("commitApprovalRequest", input);
  }

  public settleApprovalRequest(
    input: SettleApprovalRequestInput
  ): Promise<ApprovalRequestRecord> {
    return this.#request("settleApprovalRequest", input);
  }

  public abandonPendingApprovalRequests(
    input: AbandonApprovalRequestsInput
  ): Promise<readonly ApprovalRequestRecord[]> {
    return this.#request("abandonPendingApprovalRequests", input);
  }

  public auditRecords(limit?: number): Promise<readonly AuditRecord[]> {
    return this.#request("auditRecords", limit);
  }

  public appendAuditRecord(input: AppendAuditRecordInput): Promise<AuditRecord> {
    return this.#request("appendAuditRecord", input);
  }

  public claimOutbox(options: ClaimOutboxOptions): Promise<readonly OutboxDeliveryLease[]> {
    return this.#request("claimOutbox", options);
  }

  public settleOutbox(settlement: OutboxSettlement): Promise<OutboxSettlementResult> {
    return this.#request("settleOutbox", settlement);
  }

  public outboxCounts(): Promise<OutboxCounts> {
    return this.#request("outboxCounts");
  }

  public outboxCountsForChannelAccount(channelAccountId: string): Promise<OutboxCounts> {
    return this.#request("outboxCountsForChannelAccount", channelAccountId);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    await this.#ready;
    this.#closing = true;
    const exited = new Promise<void>((resolve) => this.#worker.once("exit", () => resolve()));
    await this.#request("close");
    this.#closed = true;
    await exited;
  }

  #request<Name extends StorageOperationName>(
    name: Name,
    ...args: StorageOperationArguments[Name]
  ): Promise<StorageOperationResults[Name]> {
    if (this.#closed || (this.#closing && name !== "close")) {
      return Promise.reject(new ProfileStoreError("storage_failure", "Profile store is closed"));
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<StorageOperationResults[Name]>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as StorageOperationResults[Name]),
        reject
      });
      this.#worker.postMessage({
        type: "request",
        id,
        operation: { name, args } as StorageOperation
      } satisfies StorageRequest);
    });
  }

  #handleMessage(message: unknown): void {
    if (!isStorageResponse(message)) {
      this.#fail(new ProfileStoreError("storage_failure", "Invalid Profile storage response"));
      return;
    }
    if (message.type === "ready") {
      if (!this.#readySettled) {
        this.#readySettled = true;
        this.#resolveReady();
      }
      return;
    }
    if (message.type === "fatal") {
      this.#fail(toStoreError(message.error));
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.type === "error") pending.reject(toStoreError(message.error));
    else pending.resolve(message.result);
  }

  #fail(error: Error): void {
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady(error);
    }
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export type { StorageOperation, StorageRequest, StorageResponse };

function isStorageResponse(value: unknown): value is StorageResponse {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready") return true;
  if (value.type === "fatal") return isSerializedError(value.error);
  if (value.type === "response") return Number.isSafeInteger(value.id);
  return value.type === "error" && Number.isSafeInteger(value.id) && isSerializedError(value.error);
}

function isSerializedError(value: unknown): value is SerializedStoreError {
  return isRecord(value) && typeof value.reason === "string" && typeof value.message === "string";
}

function toStoreError(value: SerializedStoreError): ProfileStoreError {
  return new ProfileStoreError(value.reason, value.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
