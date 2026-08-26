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
    case "recentMessages":
      return store.recentMessages(operation.conversationKey, operation.limit);
    case "searchText":
      return store.searchText(operation.query);
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
      value.operation.name === "recentMessages" ||
      value.operation.name === "searchText" ||
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
