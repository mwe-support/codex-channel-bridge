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
    case "commitMessage":
      return store.commitMessage(operation.value);
    case "getChannelTransportCheckpoint":
      return store.getChannelTransportCheckpoint(operation.channelAccountId);
    case "putChannelTransportCheckpoint":
      return store.putChannelTransportCheckpoint(operation.value);
    case "clearChannelTransportCheckpoint":
      return store.clearChannelTransportCheckpoint(operation.channelAccountId);
    case "recentMessages":
      return store.recentMessages(operation.conversationKey, operation.limit);
    case "searchText":
      return store.searchText(operation.query);
    case "getThreadBinding":
      return store.getThreadBinding(operation.key);
    case "createThreadBinding":
      return store.createThreadBinding(operation.value);
    case "acceptCodexInput":
      return store.acceptCodexInput(operation.value);
    case "transitionCodexInput":
      return store.transitionCodexInput(operation.transition);
    case "nonterminalCodexInputs":
      return store.nonterminalCodexInputs();
    case "commitCodexInputUncertainty":
      return store.commitCodexInputUncertainty(operation.value);
    case "commitCodexTurnResult":
      return store.commitCodexTurnResult(operation.value);
    case "commitLogicalResult":
      return store.commitLogicalResult(operation.value);
    case "commitApprovalRequest":
      return store.commitApprovalRequest(operation.value);
    case "settleApprovalRequest":
      return store.settleApprovalRequest(operation.value);
    case "abandonPendingApprovalRequests":
      return store.abandonPendingApprovalRequests(operation.value);
    case "auditRecords":
      return store.auditRecords(operation.limit);
    case "appendAuditRecord":
      return store.appendAuditRecord(operation.value);
    case "claimOutbox":
      return store.claimOutbox(operation.options);
    case "settleOutbox":
      return store.settleOutbox(operation.settlement);
    case "outboxCounts":
      return store.outboxCounts();
    case "outboxCountsForChannelAccount":
      return store.outboxCountsForChannelAccount(operation.channelAccountId);
    case "journalMode":
      return store.journalMode();
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
    (value.operation.name === "commitMessage" ||
      value.operation.name === "getChannelTransportCheckpoint" ||
      value.operation.name === "putChannelTransportCheckpoint" ||
      value.operation.name === "clearChannelTransportCheckpoint" ||
      value.operation.name === "recentMessages" ||
      value.operation.name === "searchText" ||
      value.operation.name === "getThreadBinding" ||
      value.operation.name === "createThreadBinding" ||
      value.operation.name === "acceptCodexInput" ||
      value.operation.name === "transitionCodexInput" ||
      value.operation.name === "nonterminalCodexInputs" ||
      value.operation.name === "commitCodexInputUncertainty" ||
      value.operation.name === "commitCodexTurnResult" ||
      value.operation.name === "commitLogicalResult" ||
      value.operation.name === "commitApprovalRequest" ||
      value.operation.name === "settleApprovalRequest" ||
      value.operation.name === "abandonPendingApprovalRequests" ||
      value.operation.name === "auditRecords" ||
      value.operation.name === "appendAuditRecord" ||
      value.operation.name === "claimOutbox" ||
      value.operation.name === "settleOutbox" ||
      value.operation.name === "outboxCounts" ||
      value.operation.name === "outboxCountsForChannelAccount" ||
      value.operation.name === "journalMode" ||
      value.operation.name === "close")
  );
}

function serializeError(error: unknown): { reason: ProfileStoreReason; message: string } {
  if (error instanceof ProfileStoreError) {
    return { reason: error.reason, message: error.message };
  }
  return { reason: "storage_failure", message: "Profile storage operation failed" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
