import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";

import type {
  CodexAppServerOptions,
  JsonRpcErrorObject,
  JsonRpcId,
  ManagedCodexRpcRuntime,
  ProtocolProbeResult
} from "@codex-channel-bridge/codex-app-server";
import type {
  ChannelAdapter,
  ChannelAdapterReadiness,
  ChannelTextDelivery,
  CodexInputAcceptance,
  LogicalResultInput,
  NormalizedChannelMessage,
  ProviderInboundEvent,
  ThreadBindingKey
} from "@codex-channel-bridge/core";
import {
  ProfileStoreError,
  type ClaimOutboxOptions,
  type CommitCodexInputUncertaintyInput,
  type CommitCodexTurnResultInput,
  type CodexInputTransition,
  type CreateThreadBindingInput,
  type OutboxDeliveryLease,
  type OutboxSettlement
} from "@codex-channel-bridge/profile-store";
import type { QQChannelAdapterOptions } from "@codex-channel-bridge/qq-adapter";
import type {
  WhatsAppChannelAccountAction,
  WhatsAppChannelAccountEvent,
  WhatsAppChannelAccountResult
} from "@codex-channel-bridge/whatsapp-adapter";
import {
  ProfileWorker,
  type ManagedWhatsAppChannelAccount,
  type ProfileStoreRuntime,
  type ProfileWorkerDependencies
} from "./profile-worker.js";

const testedProbe: ProtocolProbeResult = {
  cliVersion: "0.149.1",
  verification: "tested",
  schemaSha256: "test",
  requiredMethods: []
};

class FakeRuntime extends EventEmitter implements ManagedCodexRpcRuntime {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: JsonRpcId; result: unknown }> = [];
  stopped = false;
  completeTurns = true;
  startFailure = false;
  respondErrorFailure = false;

  async start() {
    if (this.startFailure) throw new Error("start failed");
    return {
      userAgent: "fake",
      platformFamily: "unix",
      platformOs: "macos",
      codexHome: "/tmp/codex-home"
    };
  }

  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    this.requests.push({ method, params });
    if (method === "model/list") return { data: [] } as TResult;
    if (method === "thread/start") return { thread: { id: "thread-1" } } as TResult;
    if (method === "thread/resume") {
      return { thread: { id: (params as { threadId: string }).threadId } } as TResult;
    }
    if (method === "turn/start") {
      queueMicrotask(() => this.emit("turnStarted"));
      if (this.completeTurns) queueMicrotask(() => this.completeTurn());
      return { turn: { id: "turn-1", status: "inProgress" } } as TResult;
    }
    if (method === "turn/steer") {
      return { turnId: (params as { expectedTurnId: string }).expectedTurnId } as TResult;
    }
    if (method === "turn/interrupt") return {} as TResult;
    throw new Error(`Unexpected method ${method}`);
  }

  completeTurn(): void {
    this.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-1", text: "done" }
      }
    });
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
    });
  }

  async notify(): Promise<void> {}
  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }
  async respondError(_id: JsonRpcId, _error: JsonRpcErrorObject): Promise<void> {
    if (this.respondErrorFailure) throw new Error("response write failed");
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class FakeStore implements ProfileStoreRuntime {
  closed = false;
  readonly messages: NormalizedChannelMessage[] = [];
  readonly logicalResults: LogicalResultInput[] = [];
  readonly transitions: CodexInputTransition[] = [];
  outboxClaimCount = 0;
  abandonedPendingAttachments = 0;
  binding?: Awaited<ReturnType<ProfileStoreRuntime["getThreadBinding"]>>;
  correlationSequence = 0;
  pendingApprovalLease?: OutboxDeliveryLease;
  readonly accountOutboxCounts = new Map<
    string,
    { pending: number; leased: number; retryWait: number; accepted: number; rejected: number }
  >();
  readonly auditRecords: import("@codex-channel-bridge/profile-store").AppendAuditRecordInput[] = [];
  readonly transportCheckpoints = new Map<
    string,
    import("@codex-channel-bridge/profile-store").ChannelTransportCheckpoint
  >();

  async commitMessage(message: NormalizedChannelMessage) {
    this.messages.push(message);
    return { recordId: `record-${this.messages.length}`, inserted: true };
  }

  async getChannelTransportCheckpoint(channelAccountId: string) {
    return this.transportCheckpoints.get(channelAccountId);
  }

  async putChannelTransportCheckpoint(
    checkpoint: import("@codex-channel-bridge/profile-store").ChannelTransportCheckpoint
  ) {
    this.transportCheckpoints.set(checkpoint.channelAccountId, checkpoint);
    return checkpoint;
  }

  async clearChannelTransportCheckpoint(channelAccountId: string) {
    this.transportCheckpoints.delete(channelAccountId);
  }

  async abandonPendingArchiveAttachments() {
    this.abandonedPendingAttachments += 1;
    return 0;
  }

  async getThreadBinding(_key: ThreadBindingKey) {
    return this.binding;
  }

  async createThreadBinding(input: CreateThreadBindingInput) {
    this.binding = { bindingId: "binding-1", ...input };
    return {
      binding: this.binding,
      inserted: true
    };
  }

  async acceptCodexInput(input: CodexInputAcceptance) {
    this.correlationSequence += 1;
    return {
      correlation: {
        correlationId: `correlation-${this.correlationSequence}`,
        ...input,
        state: "accepted" as const,
        updatedAtMs: input.acceptedAtMs
      },
      inserted: true
    };
  }

  async transitionCodexInput(transition: CodexInputTransition) {
    this.transitions.push(transition);
    return {
      correlationId: transition.correlationId,
      profileId: "profile-a",
      archiveRecordId: "record-1",
      bindingId: "binding-1",
      codexThreadId: "thread-1",
      clientUserMessageId: "client-input-1",
      state: transition.state,
      ...(transition.state === "started" || transition.state === "terminal"
        ? { codexTurnId: transition.codexTurnId }
        : {}),
      ...(transition.state === "terminal"
        ? { terminalStatus: transition.terminalStatus }
        : {}),
      ...(transition.state === "uncertain" ? { reasonCode: transition.reasonCode } : {}),
      acceptedAtMs: 1,
      updatedAtMs: transition.updatedAtMs
    };
  }

  async nonterminalCodexInputs() {
    return [];
  }

  async commitCodexInputUncertainty(input: CommitCodexInputUncertaintyInput) {
    const correlation = await this.transitionCodexInput({
      correlationId: input.correlationId,
      state: "uncertain",
      reasonCode: input.reasonCode,
      updatedAtMs: input.completedAtMs
    });
    return {
      correlation,
      logicalResult: {
        logicalResultId: `uncertain-${input.correlationId}`,
        outboxRecordIds: [`outbox-${input.correlationId}`],
        inserted: true
      }
    };
  }

  async commitLogicalResult(input: LogicalResultInput) {
    this.logicalResults.push(input);
    return { logicalResultId: "result-1", outboxRecordIds: ["outbox-1"], inserted: true };
  }

  async commitCodexTurnResult(input: CommitCodexTurnResultInput) {
    const correlation = await this.transitionCodexInput({
      correlationId: input.correlationId,
      state: "terminal",
      codexTurnId: input.result.codexTurnId,
      terminalStatus: input.terminalStatus,
      updatedAtMs: input.updatedAtMs
    });
    const logicalResult = await this.commitLogicalResult(input.result);
    return { correlation, logicalResult };
  }

  async commitApprovalRequest(input: import("@codex-channel-bridge/profile-store").CommitApprovalRequestInput) {
    const logicalResultId = `approval:${input.approvalToken}`;
    this.pendingApprovalLease = {
      outboxRecordId: `approval-outbox:${input.approvalToken}`,
      logicalResultId,
      segmentIndex: 0,
      provider: input.provider,
      channelAccountId: input.channelAccountId,
      channelAccountEpochId: input.channelAccountEpochId,
      target: input.target,
      text: input.prompt,
      attemptNumber: 1,
      leaseToken: `lease:${input.approvalToken}`,
      leaseExpiresAtMs: input.createdAtMs + 30_000
    };
    return {
      approval: {
        approvalToken: input.approvalToken,
        operationKind: input.operationKind,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        channelAccountId: input.channelAccountId,
        channelAccountEpochId: input.channelAccountEpochId,
        conversationKey: input.target.conversationKey,
        providerIdentity: input.providerIdentity,
        state: "pending" as const,
        presentationState: "pending" as const,
        createdAtMs: input.createdAtMs,
        expiresAtMs: input.expiresAtMs
      },
      logicalResult: {
        logicalResultId,
        outboxRecordIds: [`approval-outbox:${input.approvalToken}`],
        inserted: true
      }
    };
  }

  async settleApprovalRequest(input: import("@codex-channel-bridge/profile-store").SettleApprovalRequestInput) {
    return {
      approvalToken: input.approvalToken,
      operationKind: "command_execution" as const,
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      channelAccountId: "qq-main",
      channelAccountEpochId: "epoch-1",
      conversationKey: "qq:private:user-1",
      providerIdentity: "user-1",
      state: input.state,
      presentationState: "accepted" as const,
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      createdAtMs: 1,
      expiresAtMs: 2,
      settledAtMs: input.settledAtMs
    };
  }

  async abandonPendingApprovalRequests(_input: import("@codex-channel-bridge/profile-store").AbandonApprovalRequestsInput) {
    return [];
  }

  async claimOutbox(_options: ClaimOutboxOptions) {
    this.outboxClaimCount += 1;
    const lease = this.pendingApprovalLease;
    this.pendingApprovalLease = undefined;
    return lease ? [lease] : [];
  }

  async settleOutbox(settlement: OutboxSettlement) {
    return {
      outboxRecordId: settlement.outboxRecordId,
      logicalResultId: "result-1",
      status: settlement.outcome === "accepted" ? "accepted" as const : "retry_wait" as const
    };
  }

  async outboxCounts() {
    return { pending: 0, leased: 0, retryWait: 0, accepted: 0, rejected: 0 };
  }

  async outboxCountsForChannelAccount(channelAccountId: string) {
    return this.accountOutboxCounts.get(channelAccountId) ?? this.outboxCounts();
  }

  async appendAuditRecord(input: import("@codex-channel-bridge/profile-store").AppendAuditRecordInput) {
    this.auditRecords.push(input);
    return {
      auditRecordId: `audit-${this.auditRecords.length}`,
      ...input
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeAdapter implements ChannelAdapter {
  started = false;
  stopped = false;
  startFailure = false;
  readonly deliveries: ChannelTextDelivery[] = [];
  #readiness: ChannelAdapterReadiness = "stopped";
  readonly #readinessListeners = new Set<(readiness: ChannelAdapterReadiness) => void>();
  #onEvent?: (event: ProviderInboundEvent) => Promise<void>;

  readiness(): ChannelAdapterReadiness {
    return this.#readiness;
  }

  subscribeReadiness(listener: (readiness: ChannelAdapterReadiness) => void): () => void {
    this.#readinessListeners.add(listener);
    return () => this.#readinessListeners.delete(listener);
  }

  async start(onEvent: (event: ProviderInboundEvent) => Promise<void>): Promise<void> {
    if (this.startFailure) throw new Error("adapter unavailable");
    this.started = true;
    this.#onEvent = onEvent;
    this.setReadiness("ready");
  }

  async sendText(delivery: ChannelTextDelivery) {
    this.deliveries.push(delivery);
    return {
      logicalResultId: delivery.logicalResultId,
      segmentIndex: delivery.segmentIndex,
      outcome: "accepted" as const,
      providerMessageId: `delivery-${this.deliveries.length}`,
      acceptedAtMs: 1
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.setReadiness("stopped");
  }

  async receive(event: ProviderInboundEvent): Promise<void> {
    if (!this.#onEvent) throw new Error("adapter is not started");
    await this.#onEvent(event);
  }

  setReadiness(readiness: ChannelAdapterReadiness): void {
    this.#readiness = readiness;
    for (const listener of this.#readinessListeners) listener(readiness);
  }
}

class FakeWhatsAppAccount extends FakeAdapter implements ManagedWhatsAppChannelAccount {
  readonly actions: WhatsAppChannelAccountAction[] = [];

  async execute(
    action: WhatsAppChannelAccountAction,
    onEvent?: (event: WhatsAppChannelAccountEvent) => Promise<void> | void
  ): Promise<WhatsAppChannelAccountResult> {
    this.actions.push(action);
    if (action.kind === "pair") {
      await onEvent?.({
        kind: "pairing_material",
        material: { kind: "qr", value: "sensitive-test-qr", expiresAtMs: 123 }
      });
      return { kind: "paired", generationId: "generation-1" };
    }
    if (action.kind === "connect") return { kind: "connected" };
    if (action.kind === "disconnect") return { kind: "disconnected" };
    if (action.kind === "logout") return { kind: "logout_uncertain" };
    return { kind: "local_auth_forgotten" };
  }
}

function dependencies(runtime: FakeRuntime, store = new FakeStore()): ProfileWorkerDependencies {
  return {
    probe: async () => testedProbe,
    createRuntime: (_options: CodexAppServerOptions) => runtime,
    createStore: async () => store,
    createSecretResolver: async () => ({ resolve: async (reference) => `resolved:${reference}` }),
    createQQAdapter: () => new FakeAdapter(),
    createWhatsAppAccount: () => new FakeWhatsAppAccount()
  };
}

function inboundEvent(sequence = 1, text = "hello"): ProviderInboundEvent {
  return {
    message: {
      provider: "qq",
      providerEventId: `["message-${sequence}",null]`,
      conversationKind: "private",
      providerConversationId: "user-1",
      providerIdentity: "user-1",
      observedAtMs: sequence,
      text
    },
    attention: "direct",
    replyTarget: {
      conversationKind: "private",
      providerConversationId: "user-1",
      providerReplyEventId: `message-${sequence}`
    }
  };
}

test("starts a Profile only after schema and live model probes pass", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state"
    },
    dependencies(runtime, store)
  );
  const health = await worker.start();
  assert.deepEqual(health, {
    profileId: "profile-a",
    readiness: "ready",
    reason: null,
    codexVersion: "0.149.1",
    codexVerification: "tested"
  });
  assert.equal(runtime.requests[0]?.method, "model/list");
  assert.equal(store.abandonedPendingAttachments, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(store.outboxClaimCount >= 1);
  await worker.stop();
  assert.equal(runtime.stopped, true);
});

test("runs a minimal Thread and Turn without storing Codex history", async () => {
  const runtime = new FakeRuntime();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state"
    },
    dependencies(runtime)
  );
  await worker.start();
  const result = await worker.runTurn("answer briefly");
  assert.deepEqual({ ...result, clientUserMessageId: "redacted-for-assertion" }, {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: "done",
    clientUserMessageId: "redacted-for-assertion"
  });
  assert.deepEqual(
    runtime.requests.map((request) => request.method),
    ["model/list", "thread/start", "turn/start"]
  );
  assert.equal(runtime.listenerCount("notification"), 1);
  await worker.stop();
});

test("fails closed on a relative Workspace path", async () => {
  const runtime = new FakeRuntime();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "relative",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state"
    },
    dependencies(runtime)
  );
  const health = await worker.start();
  assert.equal(health.readiness, "unavailable");
  assert.equal(health.reason, "invalid_profile_configuration");
});

test("opens and closes Profile storage with the Worker lifecycle", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state"
    },
    dependencies(runtime, store)
  );
  await worker.start();
  await worker.stop();
  assert.equal(store.closed, true);
});

test("fails closed before starting Codex when Profile storage cannot open", async () => {
  const runtime = new FakeRuntime();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state"
    },
    {
      ...dependencies(runtime),
      createStore: async () => {
        throw new Error("store unavailable");
      }
    }
  );
  const health = await worker.start();
  assert.equal(health.readiness, "unavailable");
  assert.equal(health.reason, "profile_store_unavailable");
  assert.equal(runtime.requests.length, 0);
});

test("keeps adapters archiving while Codex is unavailable without creating an outage backlog", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "open", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    {
      ...dependencies(runtime, store),
      probe: async () => {
        throw new Error("Codex unavailable");
      },
      createQQAdapter: () => adapter
    }
  );

  assert.deepEqual(await worker.start(), {
    profileId: "profile-a",
    readiness: "unavailable",
    reason: "codex_start_failed"
  });
  assert.equal(adapter.started, true);
  const ingress = once(worker, "channelIngress");
  const rejectionDelivered = once(worker, "channelIngressRejectionDelivered");
  await adapter.receive(inboundEvent(1, "must not run later"));
  const [decision] = await ingress;
  await rejectionDelivered;
  assert.equal(decision.disposition.kind, "rejected");
  assert.equal(decision.disposition.reason, "unavailable");
  assert.equal(store.messages.length, 1);
  assert.equal(runtime.requests.length, 0);
  assert.match(adapter.deliveries[0]?.text ?? "", /not queued or executed/);
  assert.equal(adapter.deliveries[0]?.target.providerReplyEventId, undefined);
  await worker.stop();
});

test("reports migration_required without starting Codex for an older Bridge schema", async () => {
  const runtime = new FakeRuntime();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state"
    },
    {
      ...dependencies(runtime),
      createStore: async () => {
        throw new ProfileStoreError("migration_required", "explicit migration required");
      }
    }
  );
  const health = await worker.start();
  assert.equal(health.readiness, "unavailable");
  assert.equal(health.reason, "migration_required");
  assert.equal(runtime.requests.length, 0);
});

test("resolves QQ Secret References, starts the adapter, and archives inbound events", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  const resolved: string[] = [];
  let adapterOptions: QQChannelAdapterOptions | undefined;
  const deps: ProfileWorkerDependencies = {
    ...dependencies(runtime, store),
    createSecretResolver: async (secretsFile) => {
      assert.equal(secretsFile, "/tmp/bridge-state/private.env");
      return {
        resolve: async (reference) => {
          resolved.push(reference);
          return `resolved:${reference}`;
        }
      };
    },
    createQQAdapter: (options) => {
      adapterOptions = options;
      return adapter;
    }
  };
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      secretsFile: "/tmp/bridge-state/private.env",
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "deny", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    deps
  );

  assert.equal((await worker.start()).readiness, "ready");
  assert.deepEqual(resolved.sort(), ["env:QQ_APP_ID", "env:QQ_APP_SECRET"]);
  assert.equal(adapterOptions?.appId, "resolved:env:QQ_APP_ID");
  assert.equal(adapterOptions?.appSecret, "resolved:env:QQ_APP_SECRET");
  await adapterOptions?.gatewaySessionRepository.save({ sessionId: "gateway-session", lastSeq: 42 });
  assert.deepEqual(await adapterOptions?.gatewaySessionRepository.load(), {
    sessionId: "gateway-session",
    lastSeq: 42
  });
  assert.equal(store.transportCheckpoints.get("qq-primary")?.provider, "qq");
  await adapterOptions?.gatewaySessionRepository.clear();
  assert.equal(await adapterOptions?.gatewaySessionRepository.load(), null);
  await adapter.receive(inboundEvent());
  assert.deepEqual(store.messages, [
    {
      profileId: "profile-a",
      provider: "qq",
      channelAccountId: "qq-primary",
      channelAccountEpochId: "epoch-1",
      providerEventId: '["message-1",null]',
      conversationKey: "qq:qq-primary:private:user-1",
      conversationKind: "private",
      providerConversationId: "user-1",
      providerIdentity: "user-1",
      observedAtMs: 1,
      text: "hello"
    }
  ]);
  await worker.stop();
  assert.equal(adapter.stopped, true);
});

test("opens a fixed Profile-local WhatsApp account and supervises it independently", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const adapter = new FakeWhatsAppAccount();
  let authDirectory = "";
  let secretResolverCalled = false;
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      channelAccounts: {
        "wa-primary": {
          id: "wa-primary",
          provider: "whatsapp",
          enabled: true,
          epochId: "epoch-1",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "deny", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    {
      ...dependencies(runtime, store),
      createSecretResolver: async () => {
        secretResolverCalled = true;
        throw new Error("not needed");
      },
      createWhatsAppAccount: (options) => {
        authDirectory = options.rootDirectoryPath;
        return adapter;
      }
    }
  );
  const health = await worker.start();
  assert.equal(health.readiness, "ready");
  assert.equal(secretResolverCalled, false);
  assert.equal(authDirectory, "/tmp/bridge-state/channel-auth/wa-primary");

  const degraded = once(worker, "health");
  adapter.setReadiness("degraded");
  assert.equal((await degraded)[0].readiness, "degraded");
  assert.equal(worker.health().reason, "channel_adapter_unavailable");
  const recovered = once(worker, "health");
  adapter.setReadiness("ready");
  assert.equal((await recovered)[0].readiness, "ready");
  assert.equal(worker.health().reason, null);

  await adapter.receive({
    ...inboundEvent(1, "hello"),
    message: {
      ...inboundEvent(1, "hello").message,
      provider: "whatsapp",
      providerEventId: '["15551112222@s.whatsapp.net",null,"message-1"]',
      providerConversationId: "15551112222@s.whatsapp.net",
      providerIdentity: "15551112222@s.whatsapp.net"
    },
    replyTarget: {
      conversationKind: "private",
      providerConversationId: "15551112222@s.whatsapp.net",
      providerReplyEventId: "message-1"
    }
  });
  assert.equal(store.messages[0]?.provider, "whatsapp");
  await worker.stop();
  assert.equal(adapter.stopped, true);
});

test("executes a WhatsApp lifecycle action only while its Channel Account is quiescent", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const account = new FakeWhatsAppAccount();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      channelAccounts: {
        "wa-primary": {
          id: "wa-primary",
          provider: "whatsapp",
          enabled: true,
          epochId: "epoch-1",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "deny", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    { ...dependencies(runtime, store), createWhatsAppAccount: () => account }
  );
  await worker.start();

  const events: WhatsAppChannelAccountEvent[] = [];
  assert.deepEqual(
    await worker.executeWhatsAppAccountAction(
      "wa-primary",
      { kind: "pair" },
      (event) => {
        events.push(event);
      }
    ),
    { kind: "paired", generationId: "generation-1" }
  );
  assert.equal(events[0]?.kind, "pairing_material");
  assert.deepEqual(store.auditRecords.map(({ action, result, targetReference }) => ({
    action,
    result,
    targetReference
  })), [
    { action: "whatsapp_pair", result: "started", targetReference: "wa-primary" },
    { action: "whatsapp_pair", result: "paired", targetReference: "wa-primary" }
  ]);

  store.accountOutboxCounts.set("wa-primary", {
    pending: 1,
    leased: 0,
    retryWait: 0,
    accepted: 0,
    rejected: 0
  });
  await assert.rejects(
    worker.executeWhatsAppAccountAction("wa-primary", { kind: "disconnect" }),
    /live work/
  );
  assert.equal(account.actions.length, 1);
  await worker.stop();
});

test("routes an allowed QQ message through Codex correlation into the durable Outbox", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "open", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    {
      ...dependencies(runtime, store),
      createQQAdapter: () => adapter
    }
  );
  await worker.start();
  const completed = once(worker, "channelTurnCompleted");
  await adapter.receive(inboundEvent());
  await completed;

  assert.deepEqual(
    runtime.requests.map((request) => request.method),
    ["model/list", "thread/start", "turn/start"]
  );
  assert.equal(store.logicalResults.length, 1);
  assert.equal(store.logicalResults[0]?.segments[0]?.text, "done");
  assert.equal(store.logicalResults[0]?.target.providerReplyEventId, "message-1");
  await worker.stop();
});

test("routes a second message on an active conversation through native turn/steer", async () => {
  const runtime = new FakeRuntime();
  runtime.completeTurns = false;
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      admission: {
        mode: "steer",
        maximumActiveTurns: 1,
        queueCapacity: 16,
        maximumQueueAgeMs: 300_000,
        accountRateLimit: 30,
        accountRateWindowMs: 60_000
      },
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "open", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    {
      ...dependencies(runtime, store),
      createQQAdapter: () => adapter
    }
  );
  await worker.start();

  const started = once(runtime, "turnStarted");
  await adapter.receive(inboundEvent(1, "first"));
  await started;
  const steered = once(worker, "channelTurnSteered");
  await adapter.receive(inboundEvent(2, "change direction"));
  await steered;

  assert.deepEqual(runtime.requests.at(-1), {
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "change direction" }],
      expectedTurnId: "turn-1"
    }
  });

  const completed = once(worker, "channelTurnCompleted");
  runtime.completeTurn();
  await completed;
  assert.equal(store.logicalResults.length, 1);
  await worker.stop();
});

test("allows only the active Turn initiator to request native interruption", async () => {
  const runtime = new FakeRuntime();
  runtime.completeTurns = false;
  const adapter = new FakeAdapter();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "open", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    {
      ...dependencies(runtime),
      createQQAdapter: () => adapter
    }
  );
  await worker.start();
  const started = once(runtime, "turnStarted");
  await adapter.receive(inboundEvent(1, "first"));
  await started;

  const interrupted = once(worker, "channelTurnInterruptRequested");
  await adapter.receive(inboundEvent(2, "/stop"));
  await interrupted;
  assert.deepEqual(runtime.requests.at(-1), {
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-1" }
  });

  const completed = once(worker, "channelTurnCompleted");
  runtime.completeTurn();
  await completed;
  await worker.stop();
});

test("presents stable Codex Approval Requests and accepts only a bound Channel response", async () => {
  const runtime = new FakeRuntime();
  runtime.completeTurns = false;
  const adapter = new FakeAdapter();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "open", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    {
      ...dependencies(runtime),
      createQQAdapter: () => adapter
    }
  );
  await worker.start();
  const started = once(runtime, "turnStarted");
  await adapter.receive(inboundEvent(1, "first"));
  await started;

  const routed = once(worker, "channelApprovalRequested");
  const queued = once(worker, "channelApprovalQueued");
  runtime.emit("serverRequest", {
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1 }
  });
  const [approval] = await routed;
  await queued;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approval.context.providerIdentity, "user-1");
  assert.equal(approval.context.replyTarget.providerConversationId, "user-1");
  assert.match(adapter.deliveries[0]?.text ?? "", new RegExp(`/approve ${approval.approvalToken} accept`));

  const responded = once(worker, "channelApprovalResponded");
  await adapter.receive(inboundEvent(2, `/approve ${approval.approvalToken} accept`));
  await responded;
  assert.deepEqual(runtime.responses, [{ id: 42, result: { decision: "accept" } }]);

  const completed = once(worker, "channelTurnCompleted");
  runtime.completeTurn();
  await completed;
  await worker.stop();
});

test("keeps Codex and sibling adapters available when one QQ adapter fails", async () => {
  const runtime = new FakeRuntime();
  const healthy = new FakeAdapter();
  const failed = new FakeAdapter();
  failed.startFailure = true;
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      channelAccounts: Object.fromEntries(
        ["qq-failed", "qq-healthy"].map((id) => [
          id,
          {
            id,
            provider: "qq" as const,
            enabled: true,
            epochId: "epoch-1",
            appId: "env:QQ_APP_ID",
            appSecret: "env:QQ_APP_SECRET",
            groupThreadScope: "conversation" as const,
            accessPolicy: {
              privateChats: { mode: "deny" as const, allow: [] },
              groupChats: { mode: "deny" as const, allow: [] },
              groupParticipants: { mode: "deny" as const, allow: [] }
            }
          }
        ])
      )
    },
    {
      ...dependencies(runtime),
      createQQAdapter: (options) =>
        options.channelAccountId === "qq-failed" ? failed : healthy
    }
  );

  const health = await worker.start();
  assert.equal(health.readiness, "degraded");
  assert.equal(health.reason, "channel_adapter_unavailable");
  assert.equal(healthy.started, true);
  assert.equal((await worker.runTurn("still available")).status, "completed");
  await worker.stop();
  assert.equal(healthy.stopped, true);
});

test("isolates an adapter that emits facts for a different provider", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "deny", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    {
      ...dependencies(runtime, store),
      createQQAdapter: () => adapter
    }
  );

  assert.equal((await worker.start()).readiness, "ready");
  const event = inboundEvent();
  await adapter.receive({
    ...event,
    message: { ...event.message, provider: "whatsapp" }
  });

  assert.equal(worker.health().readiness, "degraded");
  assert.equal(worker.health().reason, "channel_adapter_unavailable");
  assert.equal(adapter.stopped, true);
  assert.equal(store.messages.length, 0);
  assert.equal((await worker.runTurn("Codex remains available")).status, "completed");
  await worker.stop();
});

test("drains an active Channel Turn before stopping the App Server and adapter", async () => {
  const runtime = new FakeRuntime();
  runtime.completeTurns = false;
  const adapter = new FakeAdapter();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      drainTimeoutMs: 500,
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "open", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    { ...dependencies(runtime), createQQAdapter: () => adapter }
  );
  await worker.start();
  const started = once(runtime, "turnStarted");
  await adapter.receive(inboundEvent(1, "long turn"));
  await started;

  const stopped = worker.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(worker.health().readiness, "draining");
  assert.equal(runtime.stopped, false);
  assert.equal(adapter.stopped, false);

  runtime.completeTurn();
  const health = await stopped;
  assert.equal(health.readiness, "stopped");
  assert.equal(runtime.stopped, true);
  assert.equal(adapter.stopped, true);
  assert.equal(
    runtime.requests.some((request) => request.method === "turn/interrupt"),
    false
  );
});

test("interrupts an unresolved Turn at the drain deadline and reports uncertainty", async () => {
  const runtime = new FakeRuntime();
  runtime.completeTurns = false;
  const adapter = new FakeAdapter();
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      drainTimeoutMs: 10,
      childExitTimeoutMs: 25,
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "open", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    { ...dependencies(runtime), createQQAdapter: () => adapter }
  );
  await worker.start();
  const started = once(runtime, "turnStarted");
  await adapter.receive(inboundEvent(1, "never completes"));
  await started;

  const drained = once(worker, "drainCompleted");
  await worker.stop();
  const [result] = await drained as unknown as [
    { completed: boolean; snapshot: { activeTurns: number } }
  ];
  assert.equal(result.completed, false);
  assert.equal(result.snapshot.activeTurns, 1);
  assert.deepEqual(
    runtime.requests.find((request) => request.method === "turn/interrupt"),
    {
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" }
    }
  );
  assert.equal(runtime.stopped, true);
});

test("restarts a failed App Server generation without restarting adapters or replaying input", async () => {
  const firstRuntime = new FakeRuntime();
  firstRuntime.completeTurns = false;
  const secondRuntime = new FakeRuntime();
  const runtimes = [firstRuntime, secondRuntime];
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  let probeCalls = 0;
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state",
      channelAccounts: {
        "qq-primary": {
          id: "qq-primary",
          provider: "qq",
          enabled: true,
          epochId: "epoch-1",
          appId: "env:QQ_APP_ID",
          appSecret: "env:QQ_APP_SECRET",
          groupThreadScope: "conversation",
          accessPolicy: {
            privateChats: { mode: "open", allow: [] },
            groupChats: { mode: "deny", allow: [] },
            groupParticipants: { mode: "deny", allow: [] }
          }
        }
      }
    },
    {
      ...dependencies(firstRuntime, store),
      probe: async () => {
        probeCalls += 1;
        return testedProbe;
      },
      createRuntime: () => {
        const runtime = runtimes.shift();
        if (!runtime) throw new Error("unexpected runtime generation");
        return runtime;
      },
      createQQAdapter: () => adapter,
      codexRestartDelaysMs: [0],
      codexRestartCooldownMs: 1_000,
      sleep: async () => undefined
    }
  );
  await worker.start();
  const started = once(firstRuntime, "turnStarted");
  await adapter.receive(inboundEvent(1, "work before crash"));
  await started;

  const failed = once(worker, "channelTurnFailed");
  const recovered = once(worker, "codexGenerationRecovered");
  firstRuntime.emit("protocolFault", new Error("child exited"));
  await Promise.all([failed, recovered]);

  assert.equal(firstRuntime.stopped, true);
  assert.equal(adapter.stopped, false);
  assert.equal(worker.health().readiness, "ready");
  assert.equal(probeCalls, 2);
  assert.equal(
    store.transitions.some(
      (transition) => transition.state === "uncertain" &&
        transition.reasonCode === "turn_result_uncertain"
    ),
    true
  );
  assert.deepEqual(secondRuntime.requests.map((request) => request.method), ["model/list"]);

  const completed = once(worker, "channelTurnCompleted");
  await adapter.receive(inboundEvent(2, "continue deliberately"));
  await completed;
  assert.deepEqual(
    secondRuntime.requests.map((request) => request.method),
    ["model/list", "thread/resume", "turn/start"]
  );
  await worker.stop();
});

test("restarts the App Server generation when a server-request response cannot be written", async () => {
  const firstRuntime = new FakeRuntime();
  firstRuntime.respondErrorFailure = true;
  const secondRuntime = new FakeRuntime();
  const runtimes = [firstRuntime, secondRuntime];
  let probeCalls = 0;
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state"
    },
    {
      ...dependencies(firstRuntime),
      probe: async () => {
        probeCalls += 1;
        return testedProbe;
      },
      createRuntime: () => {
        const runtime = runtimes.shift();
        if (!runtime) throw new Error("unexpected runtime generation");
        return runtime;
      },
      codexRestartDelaysMs: [0],
      sleep: async () => undefined
    }
  );
  await worker.start();
  const recovered = once(worker, "codexGenerationRecovered");
  firstRuntime.emit("serverRequest", {
    id: 7,
    method: "unsupported/request",
    params: {}
  });
  await recovered;
  assert.equal(firstRuntime.stopped, true);
  assert.equal(worker.health().readiness, "ready");
  assert.equal(probeCalls, 2);
  await worker.stop();
});

test("opens a Profile-local circuit after the bounded App Server restart budget", async () => {
  const firstRuntime = new FakeRuntime();
  const failedOne = new FakeRuntime();
  failedOne.startFailure = true;
  const failedTwo = new FakeRuntime();
  failedTwo.startFailure = true;
  const runtimes = [firstRuntime, failedOne, failedTwo];
  const cooldown = new Promise<void>(() => undefined);
  const worker = new ProfileWorker(
    {
      profileId: "profile-a",
      workspace: "/tmp/workspace",
      codexHome: "/tmp/codex-home",
      stateDirectory: "/tmp/bridge-state"
    },
    {
      ...dependencies(firstRuntime),
      createRuntime: () => {
        const runtime = runtimes.shift();
        if (!runtime) throw new Error("unexpected runtime generation");
        return runtime;
      },
      codexRestartDelaysMs: [0, 0],
      codexRestartCooldownMs: 99,
      sleep: (delayMs) => delayMs === 99 ? cooldown : Promise.resolve()
    }
  );
  await worker.start();
  firstRuntime.emit("protocolFault", new Error("child exited"));
  await eventually(() => worker.health().reason === "codex_restart_exhausted");
  assert.equal(worker.health().readiness, "unavailable");
  assert.equal(runtimes.length, 0);
  await worker.stop();
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}
