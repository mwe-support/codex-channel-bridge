import { Worker } from "node:worker_threads";

import type {
  CodexInputAcceptance,
  CodexInputCorrelation,
  LogicalResultInput,
  NormalizedChannelMessage,
  ThreadBinding,
  ThreadBindingKey
} from "@codex-channel-bridge/core";

import {
  ProfileStoreError,
  type AbandonArchiveAttachmentsInput,
  type ArchiveAttachmentRecord,
  type ArchiveObservationCommitResult,
  type ArchiveCommitResult,
  type ArchiveHybridSearch,
  type ArchiveHybridSearchHit,
  type ArchivePurgePreview,
  type ArchivePurgeResult,
  type ArchivePurgeScope,
  type ApplyArchivePurgeInput,
  type AppendAuditRecordInput,
  type ArchivedChannelMessage,
  type ArchiveTextSearch,
  type ArchiveTextSearchHit,
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
  type LogicalResultCommitResult,
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

type StorageOperation =
  | { readonly name: "commitMessage"; readonly value: NormalizedChannelMessage }
  | { readonly name: "commitObservation"; readonly value: CommitArchiveObservationInput }
  | { readonly name: "archiveAttachments"; readonly messageRecordId: string }
  | { readonly name: "settleArchiveAttachment"; readonly value: SettleArchiveAttachmentInput }
  | { readonly name: "mirroredMediaBytes" }
  | { readonly name: "abandonPendingArchiveAttachments"; readonly value: AbandonArchiveAttachmentsInput }
  | { readonly name: "getChannelTransportCheckpoint"; readonly channelAccountId: string }
  | { readonly name: "putChannelTransportCheckpoint"; readonly value: ChannelTransportCheckpoint }
  | { readonly name: "clearChannelTransportCheckpoint"; readonly channelAccountId: string }
  | { readonly name: "recentMessages"; readonly conversationKey: string; readonly limit?: number }
  | { readonly name: "searchText"; readonly query: ArchiveTextSearch }
  | { readonly name: "searchHybrid"; readonly query: ArchiveHybridSearch }
  | { readonly name: "previewArchivePurge"; readonly scope: ArchivePurgeScope }
  | { readonly name: "applyArchivePurge"; readonly value: ApplyArchivePurgeInput }
  | { readonly name: "profilePurgeState" }
  | { readonly name: "getThreadBinding"; readonly key: ThreadBindingKey }
  | { readonly name: "createThreadBinding"; readonly value: CreateThreadBindingInput }
  | { readonly name: "replaceThreadBinding"; readonly value: CreateThreadBindingInput }
  | { readonly name: "detachThreadBinding"; readonly key: ThreadBindingKey }
  | { readonly name: "acceptCodexInput"; readonly value: CodexInputAcceptance }
  | { readonly name: "transitionCodexInput"; readonly transition: CodexInputTransition }
  | { readonly name: "nonterminalCodexInputs" }
  | { readonly name: "commitCodexInputUncertainty"; readonly value: CommitCodexInputUncertaintyInput }
  | { readonly name: "commitCodexTurnResult"; readonly value: CommitCodexTurnResultInput }
  | { readonly name: "commitLogicalResult"; readonly value: LogicalResultInput }
  | { readonly name: "commitApprovalRequest"; readonly value: CommitApprovalRequestInput }
  | { readonly name: "settleApprovalRequest"; readonly value: SettleApprovalRequestInput }
  | { readonly name: "abandonPendingApprovalRequests"; readonly value: AbandonApprovalRequestsInput }
  | { readonly name: "auditRecords"; readonly limit?: number }
  | { readonly name: "appendAuditRecord"; readonly value: AppendAuditRecordInput }
  | { readonly name: "claimOutbox"; readonly options: ClaimOutboxOptions }
  | { readonly name: "settleOutbox"; readonly settlement: OutboxSettlement }
  | { readonly name: "outboxCounts" }
  | { readonly name: "outboxCountsForChannelAccount"; readonly channelAccountId: string }
  | { readonly name: "journalMode" }
  | { readonly name: "close" };

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

  public commitMessage(message: NormalizedChannelMessage): Promise<ArchiveCommitResult> {
    return this.#request({ name: "commitMessage", value: message });
  }

  public commitObservation(
    input: CommitArchiveObservationInput
  ): Promise<ArchiveObservationCommitResult> {
    return this.#request({ name: "commitObservation", value: input });
  }

  public archiveAttachments(messageRecordId: string): Promise<readonly ArchiveAttachmentRecord[]> {
    return this.#request({ name: "archiveAttachments", messageRecordId });
  }

  public settleArchiveAttachment(
    input: SettleArchiveAttachmentInput
  ): Promise<ArchiveAttachmentRecord> {
    return this.#request({ name: "settleArchiveAttachment", value: input });
  }

  public mirroredMediaBytes(): Promise<number> {
    return this.#request({ name: "mirroredMediaBytes" });
  }

  public abandonPendingArchiveAttachments(input: AbandonArchiveAttachmentsInput): Promise<number> {
    return this.#request({ name: "abandonPendingArchiveAttachments", value: input });
  }

  public getChannelTransportCheckpoint(
    channelAccountId: string
  ): Promise<ChannelTransportCheckpoint | undefined> {
    return this.#request({ name: "getChannelTransportCheckpoint", channelAccountId });
  }

  public putChannelTransportCheckpoint(
    checkpoint: ChannelTransportCheckpoint
  ): Promise<ChannelTransportCheckpoint> {
    return this.#request({ name: "putChannelTransportCheckpoint", value: checkpoint });
  }

  public clearChannelTransportCheckpoint(channelAccountId: string): Promise<void> {
    return this.#request({ name: "clearChannelTransportCheckpoint", channelAccountId });
  }

  public recentMessages(
    conversationKey: string,
    limit?: number
  ): Promise<readonly ArchivedChannelMessage[]> {
    return this.#request({
      name: "recentMessages",
      conversationKey,
      ...(limit !== undefined ? { limit } : {})
    });
  }

  public searchText(query: ArchiveTextSearch): Promise<readonly ArchiveTextSearchHit[]> {
    return this.#request({ name: "searchText", query });
  }

  public searchHybrid(query: ArchiveHybridSearch): Promise<readonly ArchiveHybridSearchHit[]> {
    return this.#request({ name: "searchHybrid", query });
  }

  public previewArchivePurge(scope: ArchivePurgeScope): Promise<ArchivePurgePreview> {
    return this.#request({ name: "previewArchivePurge", scope });
  }

  public applyArchivePurge(input: ApplyArchivePurgeInput): Promise<ArchivePurgeResult> {
    return this.#request({ name: "applyArchivePurge", value: input });
  }

  public profilePurgeState(): Promise<ProfilePurgeState> {
    return this.#request({ name: "profilePurgeState" });
  }

  public getThreadBinding(key: ThreadBindingKey): Promise<ThreadBinding | undefined> {
    return this.#request({ name: "getThreadBinding", key });
  }

  public createThreadBinding(input: CreateThreadBindingInput): Promise<ThreadBindingCommitResult> {
    return this.#request({ name: "createThreadBinding", value: input });
  }

  public replaceThreadBinding(input: CreateThreadBindingInput): Promise<ThreadBindingCommitResult> {
    return this.#request({ name: "replaceThreadBinding", value: input });
  }

  public detachThreadBinding(key: ThreadBindingKey): Promise<ThreadBinding | undefined> {
    return this.#request({ name: "detachThreadBinding", key });
  }

  public acceptCodexInput(input: CodexInputAcceptance): Promise<CodexInputCommitResult> {
    return this.#request({ name: "acceptCodexInput", value: input });
  }

  public transitionCodexInput(transition: CodexInputTransition): Promise<CodexInputCorrelation> {
    return this.#request({ name: "transitionCodexInput", transition });
  }

  public nonterminalCodexInputs(): Promise<readonly CodexInputCorrelation[]> {
    return this.#request({ name: "nonterminalCodexInputs" });
  }

  public commitCodexInputUncertainty(
    input: CommitCodexInputUncertaintyInput
  ): Promise<CodexInputUncertaintyCommitResult> {
    return this.#request({ name: "commitCodexInputUncertainty", value: input });
  }

  public commitCodexTurnResult(
    input: CommitCodexTurnResultInput
  ): Promise<CodexTurnResultCommitResult> {
    return this.#request({ name: "commitCodexTurnResult", value: input });
  }

  public commitLogicalResult(input: LogicalResultInput): Promise<LogicalResultCommitResult> {
    return this.#request({ name: "commitLogicalResult", value: input });
  }

  public commitApprovalRequest(
    input: CommitApprovalRequestInput
  ): Promise<ApprovalRequestCommitResult> {
    return this.#request({ name: "commitApprovalRequest", value: input });
  }

  public settleApprovalRequest(
    input: SettleApprovalRequestInput
  ): Promise<ApprovalRequestRecord> {
    return this.#request({ name: "settleApprovalRequest", value: input });
  }

  public abandonPendingApprovalRequests(
    input: AbandonApprovalRequestsInput
  ): Promise<readonly ApprovalRequestRecord[]> {
    return this.#request({ name: "abandonPendingApprovalRequests", value: input });
  }

  public auditRecords(limit?: number): Promise<readonly AuditRecord[]> {
    return this.#request({ name: "auditRecords", ...(limit !== undefined ? { limit } : {}) });
  }

  public appendAuditRecord(input: AppendAuditRecordInput): Promise<AuditRecord> {
    return this.#request({ name: "appendAuditRecord", value: input });
  }

  public claimOutbox(options: ClaimOutboxOptions): Promise<readonly OutboxDeliveryLease[]> {
    return this.#request({ name: "claimOutbox", options });
  }

  public settleOutbox(settlement: OutboxSettlement): Promise<OutboxSettlementResult> {
    return this.#request({ name: "settleOutbox", settlement });
  }

  public outboxCounts(): Promise<OutboxCounts> {
    return this.#request({ name: "outboxCounts" });
  }

  public outboxCountsForChannelAccount(channelAccountId: string): Promise<OutboxCounts> {
    return this.#request({ name: "outboxCountsForChannelAccount", channelAccountId });
  }

  public journalMode(): Promise<string> {
    return this.#request({ name: "journalMode" });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    await this.#ready;
    this.#closing = true;
    const exited = new Promise<void>((resolve) => this.#worker.once("exit", () => resolve()));
    await this.#request({ name: "close" });
    this.#closed = true;
    await exited;
  }

  #request<TResult>(operation: StorageOperation): Promise<TResult> {
    if (this.#closed || (this.#closing && operation.name !== "close")) {
      return Promise.reject(new ProfileStoreError("storage_failure", "Profile store is closed"));
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<TResult>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject
      });
      this.#worker.postMessage({ type: "request", id, operation } satisfies StorageRequest);
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
