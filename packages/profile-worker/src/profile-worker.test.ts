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
  type CodexInputTransition,
  type CreateThreadBindingInput,
  type OutboxSettlement
} from "@codex-channel-bridge/profile-store";
import type { QQChannelAdapterOptions } from "@codex-channel-bridge/qq-adapter";
import {
  ProfileWorker,
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
    if (method === "model/list") return { data: [] } as TResult;
    if (method === "thread/start") return { thread: { id: "thread-1" } } as TResult;
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
  async respondError(_id: JsonRpcId, _error: JsonRpcErrorObject): Promise<void> {}
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class FakeStore implements ProfileStoreRuntime {
  closed = false;
  readonly messages: NormalizedChannelMessage[] = [];
  readonly logicalResults: LogicalResultInput[] = [];
  outboxClaimCount = 0;
  binding?: Awaited<ReturnType<ProfileStoreRuntime["getThreadBinding"]>>;
  correlationSequence = 0;

  async commitMessage(message: NormalizedChannelMessage) {
    this.messages.push(message);
    return { recordId: `record-${this.messages.length}`, inserted: true };
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

  async commitLogicalResult(input: LogicalResultInput) {
    this.logicalResults.push(input);
    return { logicalResultId: "result-1", outboxRecordIds: ["outbox-1"], inserted: true };
  }

  async claimOutbox(_options: ClaimOutboxOptions) {
    this.outboxClaimCount += 1;
    return [];
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

function dependencies(runtime: FakeRuntime, store = new FakeStore()): ProfileWorkerDependencies {
  return {
    probe: async () => testedProbe,
    createRuntime: (_options: CodexAppServerOptions) => runtime,
    createStore: async () => store,
    createSecretResolver: async () => ({ resolve: async (reference) => `resolved:${reference}` }),
    createQQAdapter: () => new FakeAdapter(),
    openWhatsAppAuthState: async () => ({
      state: {} as never,
      saveCredentials: async () => undefined
    }),
    createWhatsAppAdapter: () => new FakeAdapter()
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
      providerIdentity: "user-1",
      observedAtMs: 1,
      text: "hello"
    }
  ]);
  await worker.stop();
  assert.equal(adapter.stopped, true);
});

test("opens fixed Profile-local Baileys auth and supervises WhatsApp independently", async () => {
  const runtime = new FakeRuntime();
  const store = new FakeStore();
  const adapter = new FakeAdapter();
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
      openWhatsAppAuthState: async (options) => {
        authDirectory = options.directoryPath;
        return { state: {} as never, saveCredentials: async () => undefined };
      },
      createWhatsAppAdapter: () => adapter
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
  const presented = once(worker, "channelApprovalPresented");
  runtime.emit("serverRequest", {
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1 }
  });
  const [approval] = await routed;
  await presented;
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
