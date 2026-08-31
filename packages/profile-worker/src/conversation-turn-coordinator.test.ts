import assert from "node:assert/strict";
import test from "node:test";

import type {
  CodexInputAcceptance,
  CodexInputCorrelation,
  InboundChannelEvent,
  LogicalResultInput,
  ThreadBinding,
  ThreadBindingKey
} from "@codex-channel-bridge/core";
import type {
  CodexInputCommitResult,
  CodexInputUncertaintyCommitResult,
  CommitCodexTurnResultInput,
  CommitCodexInputUncertaintyInput,
  CodexInputTransition,
  CreateThreadBindingInput,
  LogicalResultCommitResult,
  ThreadBindingCommitResult
} from "@codex-channel-bridge/profile-store";

import {
  ConversationTurnCoordinator,
  type ConversationTurnStore,
  type NativeTurnDriver
} from "./conversation-turn-coordinator.js";
import type { RunTurnOptions, TurnResult } from "./turn-coordinator.js";

class FakeStore implements ConversationTurnStore {
  binding?: ThreadBinding;
  correlation?: CodexInputCorrelation;
  readonly correlations = new Map<string, CodexInputCorrelation>();
  readonly operations: string[] = [];
  logicalResult?: LogicalResultInput;
  uncertaintyText?: string;

  async getThreadBinding(_key: ThreadBindingKey): Promise<ThreadBinding | undefined> {
    this.operations.push("binding.get");
    return this.binding;
  }

  async createThreadBinding(input: CreateThreadBindingInput): Promise<ThreadBindingCommitResult> {
    this.operations.push("binding.create");
    this.binding = {
      bindingId: "binding-1",
      ...input
    };
    return { binding: this.binding, inserted: true };
  }

  async acceptCodexInput(input: CodexInputAcceptance): Promise<CodexInputCommitResult> {
    this.operations.push("input.accept");
    const correlationId = `correlation-${this.correlations.size + 1}`;
    this.correlation = {
      correlationId,
      ...input,
      state: "accepted",
      updatedAtMs: input.acceptedAtMs
    };
    this.correlations.set(correlationId, this.correlation);
    return { correlation: this.correlation, inserted: true };
  }

  async transitionCodexInput(transition: CodexInputTransition): Promise<CodexInputCorrelation> {
    this.operations.push(`input.${transition.state}`);
    const correlation = this.correlations.get(transition.correlationId);
    assert.ok(correlation);
    this.correlation = {
      ...correlation,
      state: transition.state,
      ...(transition.state === "started" || transition.state === "terminal"
        ? { codexTurnId: transition.codexTurnId }
        : {}),
      ...(transition.state === "terminal"
        ? { terminalStatus: transition.terminalStatus }
        : {}),
      ...(transition.state === "uncertain" ? { reasonCode: transition.reasonCode } : {}),
      updatedAtMs: transition.updatedAtMs
    };
    this.correlations.set(transition.correlationId, this.correlation);
    return this.correlation;
  }

  async commitCodexInputUncertainty(
    input: CommitCodexInputUncertaintyInput
  ): Promise<CodexInputUncertaintyCommitResult> {
    this.uncertaintyText = input.text;
    const correlation = await this.transitionCodexInput({
      correlationId: input.correlationId,
      state: "uncertain",
      reasonCode: input.reasonCode,
      updatedAtMs: input.completedAtMs
    });
    this.operations.push("uncertainty.outbox");
    return {
      correlation,
      logicalResult: {
        logicalResultId: `uncertain-${input.correlationId}`,
        outboxRecordIds: [`outbox-${input.correlationId}`],
        inserted: true
      }
    };
  }

  async commitLogicalResult(input: LogicalResultInput): Promise<LogicalResultCommitResult> {
    this.operations.push("result.commit");
    this.logicalResult = input;
    return { logicalResultId: "result-1", outboxRecordIds: ["outbox-1"], inserted: true };
  }

  async commitCodexTurnResult(input: CommitCodexTurnResultInput) {
    this.operations.push("result.commit_terminal");
    this.logicalResult = input.result;
    const current = this.correlations.get(input.correlationId);
    assert.ok(current);
    const correlation: CodexInputCorrelation = {
      ...current,
      state: "terminal",
      codexTurnId: input.result.codexTurnId,
      terminalStatus: input.terminalStatus,
      updatedAtMs: input.updatedAtMs
    };
    this.correlation = correlation;
    this.correlations.set(input.correlationId, correlation);
    const logicalResult = {
      logicalResultId: "result-1",
      outboxRecordIds: ["outbox-1"],
      inserted: true
    };
    return { correlation, logicalResult };
  }
}

class FakeTurnDriver implements NativeTurnDriver {
  readonly prepared: Array<string | undefined> = [];
  readonly steered: Array<{
    text: string;
    target: { readonly threadId: string; readonly turnId: string };
  }> = [];
  failAfterStarted = false;
  failSteer = false;
  completion?: Promise<void>;

  async prepareThread(existingThreadId?: string): Promise<string> {
    this.prepared.push(existingThreadId);
    return existingThreadId ?? "thread-new";
  }

  async runPreparedTurn(
    _text: string,
    threadId: string,
    options: RunTurnOptions = {}
  ): Promise<TurnResult> {
    await options.onStarted?.(threadId, "turn-1");
    await this.completion;
    if (this.failAfterStarted) throw new Error("protocol lost after turn/start");
    return {
      threadId,
      turnId: "turn-1",
      status: "completed",
      finalText: "terminal answer",
      clientUserMessageId: options.clientUserMessageId!
    };
  }

  async steerTurn(
    text: string,
    target: { readonly threadId: string; readonly turnId: string }
  ): Promise<void> {
    this.steered.push({ text, target });
    if (this.failSteer) throw new Error("native steer failed");
  }
}

function inboundEvent(overrides: Partial<InboundChannelEvent> = {}): InboundChannelEvent {
  return {
    message: {
      profileId: "alpha",
      provider: "qq",
      channelAccountId: "qq-primary",
      channelAccountEpochId: "epoch-1",
      providerEventId: "event-1",
      conversationKey: "qq:qq-primary:group:group-1",
      conversationKind: "group",
      providerConversationId: "group-1",
      providerIdentity: "member-1",
      observedAtMs: 1_000,
      text: "run tests"
    },
    attention: "mention",
    replyTarget: {
      conversationKey: "qq:qq-primary:group:group-1",
      conversationKind: "group",
      providerConversationId: "group-1",
      providerReplyEventId: "event-1"
    },
    ...overrides
  };
}

test("persists Binding and input correlation around native Turn execution", async () => {
  const store = new FakeStore();
  const turnDriver = new FakeTurnDriver();
  let now = 2_000;
  const coordinator = new ConversationTurnCoordinator({
    profileId: "alpha",
    store,
    turnDriver,
    now: () => now++,
    newClientUserMessageId: () => "client-input-1"
  });

  const result = await coordinator.execute({
    archiveRecordId: "archive-1",
    event: inboundEvent(),
    groupThreadScope: "conversation"
  });

  assert.equal(result.binding.codexThreadId, "thread-new");
  assert.equal(result.logicalResultId, "result-1");
  assert.deepEqual(turnDriver.prepared, [undefined]);
  assert.deepEqual(store.operations, [
    "binding.get",
    "binding.create",
    "input.accept",
    "input.started",
    "result.commit_terminal"
  ]);
  assert.equal(store.logicalResult?.target.providerReplyEventId, "event-1");
  assert.equal(store.logicalResult?.segments[0]?.text, "terminal answer");
});

test("resumes an existing participant-scoped Binding", async () => {
  const store = new FakeStore();
  store.binding = {
    bindingId: "binding-existing",
    profileId: "alpha",
    conversationKey: "qq:qq-primary:group:group-1",
    scope: "participant",
    providerIdentity: "member-1",
    codexThreadId: "thread-existing",
    boundAtMs: 1_000
  };
  const turnDriver = new FakeTurnDriver();
  const coordinator = new ConversationTurnCoordinator({
    profileId: "alpha",
    store,
    turnDriver,
    now: () => 2_000,
    newClientUserMessageId: () => "client-input-1"
  });

  await coordinator.execute({
    archiveRecordId: "archive-1",
    event: inboundEvent(),
    groupThreadScope: "participant"
  });
  assert.deepEqual(turnDriver.prepared, ["thread-existing"]);
  assert.equal(store.operations.includes("binding.create"), false);
});

test("marks accepted input uncertain instead of replaying after a lost Turn result", async () => {
  const store = new FakeStore();
  const turnDriver = new FakeTurnDriver();
  turnDriver.failAfterStarted = true;
  const coordinator = new ConversationTurnCoordinator({
    profileId: "alpha",
    store,
    turnDriver,
    now: () => 2_000,
    newClientUserMessageId: () => "client-input-1"
  });

  await assert.rejects(
    coordinator.execute({
      archiveRecordId: "archive-1",
      event: inboundEvent(),
      groupThreadScope: "conversation"
    }),
    /protocol lost/
  );
  assert.equal(store.correlation?.state, "uncertain");
  assert.equal(store.correlation?.reasonCode, "turn_result_uncertain");
  assert.equal(store.operations.includes("result.commit"), false);
  assert.equal(store.operations.includes("uncertainty.outbox"), true);
  assert.match(store.uncertaintyText ?? "", /not replayed automatically/);
});

test("correlates native steer input with the active Turn and its terminal result", async () => {
  const store = new FakeStore();
  const turnDriver = new FakeTurnDriver();
  let completeTurn!: () => void;
  turnDriver.completion = new Promise<void>((resolve) => {
    completeTurn = resolve;
  });
  const coordinator = new ConversationTurnCoordinator({
    profileId: "alpha",
    store,
    turnDriver,
    now: () => 2_000,
    newClientUserMessageId: () => `client-input-${store.correlations.size + 1}`
  });

  let started!: () => void;
  const turnStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const execution = coordinator.execute({
    archiveRecordId: "archive-1",
    event: inboundEvent(),
    groupThreadScope: "conversation",
    onTurnStarted: () => started()
  });
  await turnStarted;

  const steer = await coordinator.steer({
    archiveRecordId: "archive-2",
    event: inboundEvent({
      message: {
        ...inboundEvent().message,
        providerEventId: "event-2",
        text: "change direction"
      }
    }),
    groupThreadScope: "conversation",
    target: { threadId: "thread-new", turnId: "turn-1" }
  });
  assert.equal(steer.inputCorrelationId, "correlation-2");
  assert.deepEqual(turnDriver.steered, [
    {
      text: "change direction",
      target: { threadId: "thread-new", turnId: "turn-1" }
    }
  ]);
  assert.equal(store.correlations.get("correlation-2")?.state, "started");

  completeTurn();
  await execution;
  assert.equal(store.correlations.get("correlation-2")?.state, "terminal");
  assert.equal(store.correlations.get("correlation-2")?.terminalStatus, "completed");
});

test("terminalizes a steer correlation when the Turn completed before steer returned", async () => {
  const store = new FakeStore();
  const turnDriver = new FakeTurnDriver();
  const coordinator = new ConversationTurnCoordinator({
    profileId: "alpha",
    store,
    turnDriver,
    now: () => 2_000,
    newClientUserMessageId: () => `client-input-${store.correlations.size + 1}`
  });

  await coordinator.execute({
    archiveRecordId: "archive-1",
    event: inboundEvent(),
    groupThreadScope: "conversation"
  });
  await coordinator.steer({
    archiveRecordId: "archive-2",
    event: inboundEvent({
      message: {
        ...inboundEvent().message,
        providerEventId: "event-2",
        text: "late steer response"
      }
    }),
    groupThreadScope: "conversation",
    target: { threadId: "thread-new", turnId: "turn-1" }
  });

  assert.equal(store.correlations.get("correlation-2")?.state, "terminal");
});

test("marks accepted steer input uncertain when native steer fails", async () => {
  const store = new FakeStore();
  store.binding = {
    bindingId: "binding-existing",
    profileId: "alpha",
    conversationKey: "qq:qq-primary:group:group-1",
    scope: "conversation",
    codexThreadId: "thread-existing",
    boundAtMs: 1_000
  };
  const turnDriver = new FakeTurnDriver();
  turnDriver.failSteer = true;
  const coordinator = new ConversationTurnCoordinator({
    profileId: "alpha",
    store,
    turnDriver,
    now: () => 2_000,
    newClientUserMessageId: () => "client-input-1"
  });

  await assert.rejects(
    coordinator.steer({
      archiveRecordId: "archive-1",
      event: inboundEvent(),
      groupThreadScope: "conversation",
      target: { threadId: "thread-existing", turnId: "turn-1" }
    }),
    /native steer failed/
  );
  assert.equal(store.correlation?.state, "uncertain");
  assert.equal(store.correlation?.reasonCode, "turn_steer_uncertain");
  assert.equal(store.operations.includes("uncertainty.outbox"), true);
});
