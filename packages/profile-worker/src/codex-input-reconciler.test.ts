import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  JsonRpcErrorObject,
  JsonRpcId,
  ManagedCodexRpcRuntime
} from "@codex-channel-bridge/codex-app-server";
import type { CodexInputCorrelation } from "@codex-channel-bridge/core";
import type {
  CodexInputUncertaintyCommitResult,
  CommitCodexInputUncertaintyInput
} from "@codex-channel-bridge/profile-store";

import {
  CodexInputReconciler,
  type CodexInputReconciliationStore
} from "./codex-input-reconciler.js";

class FakeRuntime extends EventEmitter implements ManagedCodexRpcRuntime {
  readonly requests: Array<{ method: string; params: unknown }> = [];

  async start() {
    return {
      userAgent: "fake",
      platformFamily: "unix",
      platformOs: "macos",
      codexHome: "/tmp/codex-home"
    };
  }

  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    this.requests.push({ method, params });
    if (method === "thread/resume") {
      return { thread: { id: (params as { threadId: string }).threadId } } as TResult;
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          turns: [
            { id: "turn-terminal", status: "completed", items: [] },
            { id: "turn-active", status: "inProgress", items: [] }
          ]
        }
      } as TResult;
    }
    throw new Error(`Unexpected method ${method}`);
  }

  async notify(): Promise<void> {}
  async respond(): Promise<void> {}
  async respondError(_id: JsonRpcId, _error: JsonRpcErrorObject): Promise<void> {}
  async stop(): Promise<void> {}
}

class FakeStore implements CodexInputReconciliationStore {
  readonly uncertaintyCommits: CommitCodexInputUncertaintyInput[] = [];

  public constructor(readonly inputs: readonly CodexInputCorrelation[]) {}

  async nonterminalCodexInputs(): Promise<readonly CodexInputCorrelation[]> {
    return this.inputs;
  }

  async commitCodexInputUncertainty(
    input: CommitCodexInputUncertaintyInput
  ): Promise<CodexInputUncertaintyCommitResult> {
    this.uncertaintyCommits.push(input);
    const current = this.inputs.find((candidate) => candidate.correlationId === input.correlationId)!;
    return {
      correlation: {
        ...current,
        state: "uncertain",
        reasonCode: input.reasonCode,
        updatedAtMs: input.completedAtMs
      },
      logicalResult: {
        logicalResultId: `uncertain-${input.correlationId}`,
        outboxRecordIds: [`outbox-${input.correlationId}`],
        inserted: true
      }
    };
  }
}

test("resumes each Thread once and marks every pre-restart input uncertain without replay", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore([
    correlation("accepted", "accepted-input"),
    correlation("started", "terminal-input", "turn-terminal"),
    correlation("started", "active-input", "turn-active"),
    correlation("started", "missing-input", "turn-missing")
  ]);
  const reconciler = new CodexInputReconciler(runtime, store, () => 2_000);

  assert.deepEqual(await reconciler.reconcile(), {
    inspected: 4,
    uncertain: 4,
    terminalObserved: 1,
    missing: 1,
    settledElsewhere: 0
  });
  assert.deepEqual(
    store.uncertaintyCommits.map((commit) => commit.reasonCode),
    [
      "turn_start_uncertain",
      "turn_result_uncommitted",
      "turn_result_uncertain",
      "turn_missing_after_restart"
    ]
  );
  assert.equal(
    store.uncertaintyCommits.every((commit) => commit.text.includes("not replayed automatically")),
    true
  );
  assert.deepEqual(runtime.requests.map((request) => request.method), [
    "thread/resume",
    "thread/read"
  ]);
  assert.equal(runtime.requests.some((request) => request.method === "turn/start"), false);
});

function correlation(
  state: "accepted" | "started",
  correlationId: string,
  codexTurnId?: string
): CodexInputCorrelation {
  return {
    correlationId,
    profileId: "profile-a",
    archiveRecordId: `archive-${correlationId}`,
    bindingId: "binding-1",
    codexThreadId: "thread-1",
    clientUserMessageId: `client-${correlationId}`,
    state,
    ...(codexTurnId ? { codexTurnId } : {}),
    acceptedAtMs: 1_000,
    updatedAtMs: 1_001
  };
}
