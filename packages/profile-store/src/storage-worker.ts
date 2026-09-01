import { parentPort, workerData } from "node:worker_threads";

import {
  ProfileStoreError,
  SqliteProfileStore,
  type OpenProfileStoreOptions,
  type ProfileStoreReason
} from "./profile-store.js";
import type { StorageOperation, StorageRequest, StorageResponse } from "./async-profile-store.js";

if (!parentPort) throw new Error("Profile storage worker requires a parent port");
const port = parentPort;

try {
  const store = SqliteProfileStore.open(workerData as OpenProfileStoreOptions);
  port.postMessage({ type: "ready" } satisfies StorageResponse);
  port.on("message", (message: unknown) => {
    if (!isStorageRequest(message)) {
      port.postMessage({
        type: "fatal",
        error: serializeError(new ProfileStoreError("storage_failure", "Invalid storage request"))
      } satisfies StorageResponse);
      store.close();
      port.close();
      return;
    }
    try {
      const result = execute(store, message.operation);
      port.postMessage({ type: "response", id: message.id, result } satisfies StorageResponse);
      if (message.operation.name === "close") port.close();
    } catch (error) {
      port.postMessage({
        type: "error",
        id: message.id,
        error: serializeError(error)
      } satisfies StorageResponse);
    }
  });
} catch (error) {
  port.postMessage({ type: "fatal", error: serializeError(error) } satisfies StorageResponse);
  port.close();
}

function execute(store: SqliteProfileStore, operation: StorageOperation): unknown {
  switch (operation.name) {
    case "commitObservation":
      return store.commitObservation(operation.args[0]);
    case "settleArchiveAttachment":
      return store.settleArchiveAttachment(operation.args[0]);
    case "mirroredMediaBytes":
      return store.mirroredMediaBytes();
    case "abandonPendingArchiveAttachments":
      return store.abandonPendingArchiveAttachments(operation.args[0]);
    case "getChannelTransportCheckpoint":
      return store.getChannelTransportCheckpoint(operation.args[0]);
    case "putChannelTransportCheckpoint":
      return store.putChannelTransportCheckpoint(operation.args[0]);
    case "clearChannelTransportCheckpoint":
      return store.clearChannelTransportCheckpoint(operation.args[0]);
    case "recentMessages":
      return store.recentMessages(operation.args[0], operation.args[1]);
    case "searchHybrid":
      return store.searchHybrid(operation.args[0]);
    case "previewArchivePurge":
      return store.previewArchivePurge(operation.args[0]);
    case "applyArchivePurge":
      return store.applyArchivePurge(operation.args[0]);
    case "profilePurgeState":
      return store.profilePurgeState();
    case "getThreadBinding":
      return store.getThreadBinding(operation.args[0]);
    case "createThreadBinding":
      return store.createThreadBinding(operation.args[0]);
    case "replaceThreadBinding":
      return store.replaceThreadBinding(operation.args[0]);
    case "detachThreadBinding":
      return store.detachThreadBinding(operation.args[0]);
    case "acceptCodexInput":
      return store.acceptCodexInput(operation.args[0]);
    case "transitionCodexInput":
      return store.transitionCodexInput(operation.args[0]);
    case "nonterminalCodexInputs":
      return store.nonterminalCodexInputs();
    case "commitCodexInputUncertainty":
      return store.commitCodexInputUncertainty(operation.args[0]);
    case "commitCodexTurnResult":
      return store.commitCodexTurnResult(operation.args[0]);
    case "commitApprovalRequest":
      return store.commitApprovalRequest(operation.args[0]);
    case "settleApprovalRequest":
      return store.settleApprovalRequest(operation.args[0]);
    case "abandonPendingApprovalRequests":
      return store.abandonPendingApprovalRequests(operation.args[0]);
    case "auditRecords":
      return store.auditRecords(operation.args[0]);
    case "appendAuditRecord":
      return store.appendAuditRecord(operation.args[0]);
    case "claimOutbox":
      return store.claimOutbox(operation.args[0]);
    case "settleOutbox":
      return store.settleOutbox(operation.args[0]);
    case "outboxCounts":
      return store.outboxCounts();
    case "outboxCountsForChannelAccount":
      return store.outboxCountsForChannelAccount(operation.args[0]);
    case "close":
      store.close();
      return null;
  }
}

function isStorageRequest(value: unknown): value is StorageRequest {
  return (
    isRecord(value) &&
    value.type === "request" &&
    Number.isSafeInteger(value.id) &&
    isRecord(value.operation) &&
    typeof value.operation.name === "string" &&
    STORAGE_OPERATIONS.has(value.operation.name) &&
    Array.isArray(value.operation.args)
  );
}

const STORAGE_OPERATIONS = new Set([
  "commitObservation", "settleArchiveAttachment", "mirroredMediaBytes",
  "abandonPendingArchiveAttachments", "getChannelTransportCheckpoint",
  "putChannelTransportCheckpoint", "clearChannelTransportCheckpoint", "recentMessages",
  "searchHybrid", "previewArchivePurge", "applyArchivePurge", "profilePurgeState",
  "getThreadBinding", "createThreadBinding", "replaceThreadBinding", "detachThreadBinding",
  "acceptCodexInput", "transitionCodexInput", "nonterminalCodexInputs",
  "commitCodexInputUncertainty", "commitCodexTurnResult", "commitApprovalRequest",
  "settleApprovalRequest", "abandonPendingApprovalRequests", "auditRecords",
  "appendAuditRecord", "claimOutbox", "settleOutbox", "outboxCounts",
  "outboxCountsForChannelAccount", "close"
]);

function serializeError(error: unknown): { reason: ProfileStoreReason; message: string } {
  if (error instanceof ProfileStoreError) {
    return { reason: error.reason, message: error.message };
  }
  return { reason: "storage_failure", message: "Profile storage operation failed" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
