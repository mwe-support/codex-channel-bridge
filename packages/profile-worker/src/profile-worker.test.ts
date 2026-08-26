import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type {
  CodexAppServerOptions,
  JsonRpcErrorObject,
  JsonRpcId,
  ManagedCodexRpcRuntime,
  ProtocolProbeResult
} from "@codex-channel-bridge/codex-app-server";
import type { ChannelAdapter, InboundChannelEvent, NormalizedChannelMessage } from "@codex-channel-bridge/core";
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
  stopped = false;

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
      queueMicrotask(() => {
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
      });
      return { turn: { id: "turn-1", status: "inProgress" } } as TResult;
    }
    throw new Error(`Unexpected method ${method}`);
  }

  async notify(): Promise<void> {}
  async respond(): Promise<void> {}
  async respondError(_id: JsonRpcId, _error: JsonRpcErrorObject): Promise<void> {}
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class FakeStore implements ProfileStoreRuntime {
  closed = false;
  readonly messages: NormalizedChannelMessage[] = [];

  async commitMessage(message: NormalizedChannelMessage) {
    this.messages.push(message);
    return { recordId: `record-${this.messages.length}`, inserted: true };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeAdapter implements ChannelAdapter {
  started = false;
  stopped = false;
  startFailure = false;
  #onEvent?: (event: InboundChannelEvent) => Promise<void>;

  async start(onEvent: (event: InboundChannelEvent) => Promise<void>): Promise<void> {
    if (this.startFailure) throw new Error("adapter unavailable");
    this.started = true;
    this.#onEvent = onEvent;
  }

  async sendText(): Promise<never> {
    throw new Error("not implemented by fake");
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async receive(event: InboundChannelEvent): Promise<void> {
    if (!this.#onEvent) throw new Error("adapter is not started");
    await this.#onEvent(event);
  }
}

function dependencies(runtime: FakeRuntime, store = new FakeStore()): ProfileWorkerDependencies {
  return {
    probe: async () => testedProbe,
    createRuntime: (_options: CodexAppServerOptions) => runtime,
    createStore: async () => store,
    createSecretResolver: async () => ({ resolve: async (reference) => `resolved:${reference}` }),
    createQQAdapter: () => new FakeAdapter()
  };
}

function inboundEvent(): InboundChannelEvent {
  return {
    message: {
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
    },
    attention: "direct",
    replyTarget: {
      conversationKey: "qq:qq-primary:private:user-1",
      conversationKind: "private",
      providerConversationId: "user-1",
      providerReplyEventId: "message-1"
    }
  };
}

test("starts a Profile only after schema and live model probes pass", async () => {
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
  const health = await worker.start();
  assert.deepEqual(health, {
    profileId: "profile-a",
    readiness: "ready",
    reason: null,
    codexVersion: "0.149.1",
    codexVerification: "tested"
  });
  assert.equal(runtime.requests[0]?.method, "model/list");
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
  assert.deepEqual(result, {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalText: "done"
  });
  assert.deepEqual(
    runtime.requests.map((request) => request.method),
    ["model/list", "thread/start", "turn/start"]
  );
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
          appSecret: "env:QQ_APP_SECRET"
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
  assert.deepEqual(store.messages, [inboundEvent().message]);
  await worker.stop();
  assert.equal(adapter.stopped, true);
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
            appSecret: "env:QQ_APP_SECRET"
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
