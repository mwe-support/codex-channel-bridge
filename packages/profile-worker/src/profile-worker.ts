import { EventEmitter } from "node:events";
import { isAbsolute, join } from "node:path";

import {
  CodexAppServerProcess,
  CodexProtocolProbeError,
  type CodexAppServerOptions,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type ManagedCodexRpcRuntime,
  type ProtocolProbeResult,
  probeCodexProtocol
} from "@codex-channel-bridge/codex-app-server";
import {
  SecretResolver,
  type AdmissionConfiguration,
  type ApprovalConfiguration,
  type ChannelAccountConfiguration
} from "@codex-channel-bridge/config";
import type {
  AuthorizedParticipantContext,
  BridgeCommand,
  ChannelAdapter,
  CodexInputAcceptance,
  CodexInputCorrelation,
  InboundChannelEvent,
  LogicalResultInput,
  NormalizedChannelMessage,
  ProviderInboundEvent,
  ProfileHealth,
  ProfileReasonCode,
  ThreadBinding,
  ThreadBindingKey,
  TrustedChannelContext
} from "@codex-channel-bridge/core";
import { ChannelDeliveryError } from "@codex-channel-bridge/core";
import {
  ProfileStore,
  ProfileStoreError,
  type ArchiveCommitResult,
  type ClaimOutboxOptions,
  type CodexInputCommitResult,
  type CodexInputTransition,
  type CreateThreadBindingInput,
  type LogicalResultCommitResult,
  type OpenProfileStoreOptions,
  type OutboxCounts,
  type OutboxDeliveryLease,
  type OutboxSettlement,
  type OutboxSettlementResult,
  type ThreadBindingCommitResult
} from "@codex-channel-bridge/profile-store";
import { QQChannelAdapter, type QQChannelAdapterOptions } from "@codex-channel-bridge/qq-adapter";
import {
  WhatsAppChannelAdapter,
  openActiveBaileysAuthState,
  type BaileysAuthStateHandle,
  type OpenBaileysAuthStateOptions,
  type WhatsAppChannelAdapterOptions
} from "@codex-channel-bridge/whatsapp-adapter";
import { AdmissionController } from "./admission-controller.js";
import { ChannelApprovalTransport } from "./channel-approval-transport.js";
import { ChannelIngressController, type ChannelIngressInput } from "./channel-ingress-controller.js";
import { CodexEventRouter } from "./codex-event-router.js";
import { CodexServerRequestRouter } from "./codex-server-request-router.js";
import { ConversationTurnCoordinator } from "./conversation-turn-coordinator.js";
import { DeliveryOutbox } from "./delivery-outbox.js";
import { InboundPipeline, InboundPipelineError } from "./inbound-pipeline.js";
import { TurnCoordinator, type TurnResult } from "./turn-coordinator.js";

export type { TurnResult } from "./turn-coordinator.js";

const CHANNEL_ADAPTER_START_TIMEOUT_MS = 30_000;
const OUTBOX_SWEEP_INTERVAL_MS = 500;

export interface ProfileWorkerConfig {
  readonly profileId: string;
  readonly workspace: string;
  readonly codexHome: string;
  readonly stateDirectory: string;
  readonly secretsFile?: string;
  readonly channelAccounts?: Readonly<Record<string, ChannelAccountConfiguration>>;
  readonly codexExecutable?: string;
  readonly admission?: AdmissionConfiguration;
  readonly approval?: ApprovalConfiguration;
}

export interface ProfileWorkerDependencies {
  readonly probe: (executable: string) => Promise<ProtocolProbeResult>;
  readonly createRuntime: (options: CodexAppServerOptions) => ManagedCodexRpcRuntime;
  readonly createStore: (options: OpenProfileStoreOptions) => Promise<ProfileStoreRuntime>;
  readonly createSecretResolver: (secretsFile: string) => Promise<ProfileSecretResolver>;
  readonly createQQAdapter: (options: QQChannelAdapterOptions) => ChannelAdapter;
  readonly openWhatsAppAuthState: (
    options: OpenBaileysAuthStateOptions
  ) => Promise<BaileysAuthStateHandle>;
  readonly createWhatsAppAdapter: (options: WhatsAppChannelAdapterOptions) => ChannelAdapter;
}

export interface ProfileStoreRuntime {
  commitMessage(message: NormalizedChannelMessage): Promise<ArchiveCommitResult>;
  getThreadBinding(key: ThreadBindingKey): Promise<ThreadBinding | undefined>;
  createThreadBinding(input: CreateThreadBindingInput): Promise<ThreadBindingCommitResult>;
  acceptCodexInput(input: CodexInputAcceptance): Promise<CodexInputCommitResult>;
  transitionCodexInput(transition: CodexInputTransition): Promise<CodexInputCorrelation>;
  commitLogicalResult(input: LogicalResultInput): Promise<LogicalResultCommitResult>;
  claimOutbox(options: ClaimOutboxOptions): Promise<readonly OutboxDeliveryLease[]>;
  settleOutbox(settlement: OutboxSettlement): Promise<OutboxSettlementResult>;
  outboxCounts(): Promise<OutboxCounts>;
  close(): Promise<void>;
}

export interface ProfileSecretResolver {
  resolve(reference: string): Promise<string>;
}

const defaultDependencies: ProfileWorkerDependencies = {
  probe: (executable) => probeCodexProtocol(executable),
  createRuntime: (options) => new CodexAppServerProcess(options),
  createStore: (options) => ProfileStore.open(options),
  createSecretResolver: (secretsFile) => SecretResolver.open({ secretsFile }),
  createQQAdapter: (options) => new QQChannelAdapter(options),
  openWhatsAppAuthState: (options) => openActiveBaileysAuthState({
    rootDirectoryPath: options.directoryPath
  }),
  createWhatsAppAdapter: (options) => new WhatsAppChannelAdapter(options)
};

export class ProfileUnavailableError extends Error {
  public constructor(public readonly health: ProfileHealth) {
    super(`Profile ${health.profileId} is ${health.readiness}: ${health.reason ?? "no reason"}`);
    this.name = "ProfileUnavailableError";
  }
}

export class ProfileWorker extends EventEmitter {
  readonly #config: ProfileWorkerConfig;
  readonly #dependencies: ProfileWorkerDependencies;
  #runtime?: ManagedCodexRpcRuntime;
  #eventRouter?: CodexEventRouter;
  #serverRequestRouter?: CodexServerRequestRouter;
  #turnCoordinator?: TurnCoordinator;
  #conversationTurnCoordinator?: ConversationTurnCoordinator;
  #deliveryOutbox?: DeliveryOutbox;
  #outboxTimer?: NodeJS.Timeout;
  #store?: ProfileStoreRuntime;
  #inboundPipeline?: InboundPipeline;
  readonly #channelIngress: ChannelIngressController;
  readonly #channelAdapters = new Map<string, ChannelAdapter>();
  readonly #channelAdapterReadiness = new Map<string, ReturnType<NonNullable<ChannelAdapter["readiness"]>>>();
  readonly #channelAdapterUnsubscribe = new Map<string, () => void>();
  readonly #channelApprovalTransport: ChannelApprovalTransport;
  #health: ProfileHealth;
  readonly #onCodexNotification = (message: JsonRpcNotification): void => {
    this.#eventRouter?.route(message);
    this.emit("notification", message);
  };

  public constructor(
    config: ProfileWorkerConfig,
    dependencies: ProfileWorkerDependencies = defaultDependencies
  ) {
    super();
    this.#config = config;
    this.#dependencies = dependencies;
    const admission = config.admission ?? {
      mode: "steer",
      maximumActiveTurns: 1,
      queueCapacity: 16,
      maximumQueueAgeMs: 300_000,
      accountRateLimit: 30,
      accountRateWindowMs: 60_000
    };
    this.#channelIngress = new ChannelIngressController(
      new AdmissionController({ ...admission, ready: false })
    );
    this.#channelApprovalTransport = new ChannelApprovalTransport({
      detail: config.approval?.detail ?? "minimal"
    });
    this.#health = {
      profileId: config.profileId,
      readiness: "stopped",
      reason: null
    };
  }

  public health(): ProfileHealth {
    return { ...this.#health };
  }

  public async start(): Promise<ProfileHealth> {
    if (!this.#isValidConfiguration()) {
      return this.#transition("unavailable", "invalid_profile_configuration");
    }
    if (!this.#store) {
      try {
        this.#store = await this.#dependencies.createStore({
          profileId: this.#config.profileId,
          databasePath: join(this.#config.stateDirectory, "bridge.sqlite")
        });
        this.#inboundPipeline = new InboundPipeline(this.#store);
      } catch (error) {
        return this.#transition(
          "unavailable",
          error instanceof ProfileStoreError && error.reason === "migration_required"
            ? "migration_required"
            : "profile_store_unavailable"
        );
      }
    }
    if (this.#runtime) return this.health();
    this.#transition("starting", null);
    const executable = this.#config.codexExecutable ?? "codex";

    let probe: ProtocolProbeResult;
    try {
      probe = await this.#dependencies.probe(executable);
    } catch (error) {
      const reason =
        error instanceof CodexProtocolProbeError ? error.reason : ("codex_start_failed" as const);
      return this.#transition("unavailable", reason);
    }

    const runtime = this.#dependencies.createRuntime({
      executable,
      codexHome: this.#config.codexHome,
      workspace: this.#config.workspace,
      bridgeVersion: "0.1.0-dev"
    });
    this.#runtime = runtime;
    const eventRouter = new CodexEventRouter();
    this.#eventRouter = eventRouter;
    this.#serverRequestRouter = new CodexServerRequestRouter(runtime, {
      approvalTimeoutMs: this.#config.approval?.timeoutMs ?? 300_000,
      onExpired: (approval) => this.emit("channelApprovalExpired", {
        approvalToken: approval.approvalToken,
        threadId: approval.threadId,
        turnId: approval.turnId
      })
    });
    this.#turnCoordinator = new TurnCoordinator({
      runtime,
      workspace: this.#config.workspace,
      eventRouter
    });
    this.#conversationTurnCoordinator = new ConversationTurnCoordinator({
      profileId: this.#config.profileId,
      store: this.#store!,
      turnDriver: this.#turnCoordinator
    });
    runtime.on("notification", this.#onCodexNotification);
    runtime.on("serverRequest", (request) => this.#handleServerRequest(request));
    runtime.on("protocolFault", () => {
      eventRouter.close(new Error("Codex App Server protocol fault"));
      this.#serverRequestRouter?.close();
      this.#emitExpiredChannelWork(this.#channelIngress.setReady(false, Date.now()).expired);
      this.#transition("unavailable", "protocol_fault", probe);
    });

    try {
      await runtime.start();
      await runtime.request("model/list", {});
    } catch {
      runtime.off("notification", this.#onCodexNotification);
      eventRouter.close(new Error("Codex App Server failed to start"));
      await runtime.stop().catch(() => undefined);
      this.#runtime = undefined;
      this.#eventRouter = undefined;
      this.#serverRequestRouter = undefined;
      this.#turnCoordinator = undefined;
      this.#conversationTurnCoordinator = undefined;
      return this.#transition("unavailable", "codex_start_failed", probe);
    }

    const adaptersReady = await this.#startChannelAdapters();
    this.#channelIngress.setReady(true, Date.now());
    this.#startDeliveryOutbox();
    return this.#transition(
      adaptersReady ? "ready" : "degraded",
      adaptersReady ? null : "channel_adapter_unavailable",
      probe
    );
  }

  public async runTurn(text: string, existingThreadId?: string): Promise<TurnResult> {
    return this.#requireReadyTurnCoordinator().runTurn(text, existingThreadId);
  }

  public async respondToApproval(
    requestId: string | number,
    context: AuthorizedParticipantContext,
    decision: "accept" | "acceptForSession" | "decline" | "cancel"
  ): Promise<void> {
    const router = this.#serverRequestRouter;
    if (!router) throw new ProfileUnavailableError(this.health());
    await router.respond(requestId, context, decision);
  }

  public async stop(): Promise<ProfileHealth> {
    const runtime = this.#runtime;
    if (runtime) this.#transition("draining", null);
    this.#eventRouter?.close(new Error("Profile worker stopped"));
    this.#serverRequestRouter?.close();
    this.#emitExpiredChannelWork(this.#channelIngress.setReady(false, Date.now()).expired);
    await this.#stopDeliveryOutbox();
    await this.#stopChannelAdapters();
    if (runtime) {
      runtime.off("notification", this.#onCodexNotification);
      await runtime.stop();
      this.#runtime = undefined;
    }
    this.#eventRouter = undefined;
    this.#serverRequestRouter = undefined;
    this.#turnCoordinator = undefined;
    this.#conversationTurnCoordinator = undefined;
    await this.#store?.close();
    this.#store = undefined;
    this.#inboundPipeline = undefined;
    return this.#transition("stopped", null);
  }

  #requireReadyTurnCoordinator(): TurnCoordinator {
    if (
      (this.#health.readiness !== "ready" && this.#health.readiness !== "degraded") ||
      !this.#turnCoordinator
    ) {
      throw new ProfileUnavailableError(this.health());
    }
    return this.#turnCoordinator;
  }

  #handleServerRequest(request: JsonRpcRequest): void {
    const router = this.#serverRequestRouter;
    if (!router) return;
    void router
      .accept(request, (threadId, turnId) => {
        const work = this.#channelIngress.controllerForTurn(threadId, turnId);
        if (!work) return undefined;
        return {
          profileId: this.#config.profileId,
          channelAccountId: work.event.message.channelAccountId,
          channelAccountEpochId: work.event.message.channelAccountEpochId,
          conversationKey: work.event.message.conversationKey,
          providerIdentity: work.event.message.providerIdentity,
          replyTarget: work.event.replyTarget
        };
      })
      .then((disposition) => {
        if (disposition.kind === "approval") {
          this.emit("channelApprovalRequested", disposition.approval);
          void this.#presentChannelApproval(disposition.approval);
        }
      })
      .catch(() => this.#transition("unavailable", "protocol_fault"));
  }

  #isValidConfiguration(): boolean {
    return (
      this.#config.profileId.trim().length > 0 &&
      isAbsolute(this.#config.workspace) &&
      isAbsolute(this.#config.codexHome) &&
      isAbsolute(this.#config.stateDirectory) &&
      (this.#config.secretsFile === undefined || isAbsolute(this.#config.secretsFile))
    );
  }

  async #startChannelAdapters(): Promise<boolean> {
    const accounts = Object.values(this.#config.channelAccounts ?? {}).filter(
      (account) => account.enabled
    );
    if (accounts.length === 0) return true;

    let resolver: ProfileSecretResolver | undefined;
    if (accounts.some((account) => account.provider === "qq")) {
      try {
        resolver = await this.#dependencies.createSecretResolver(
          this.#config.secretsFile ?? join(this.#config.stateDirectory, "secrets.env")
        );
      } catch {
        return false;
      }
    }

    const starts = await Promise.allSettled(
      accounts.map(async (account) => {
        const adapter = await this.#createChannelAdapter(account, resolver);
        this.#channelAdapters.set(account.id, adapter);
        this.#channelAdapterReadiness.set(account.id, adapter.readiness?.() ?? "starting");
        if (adapter.subscribeReadiness) {
          this.#channelAdapterUnsubscribe.set(
            account.id,
            adapter.subscribeReadiness((readiness) => {
              if (this.#channelAdapters.get(account.id) !== adapter) return;
              this.#channelAdapterReadiness.set(account.id, readiness);
              this.#refreshChannelAdapterHealth();
            })
          );
        }
        try {
          await withRejectingTimeout(
            adapter.start((event) =>
              this.#acceptChannelEvent(
                {
                  profileId: this.#config.profileId,
                  provider: account.provider,
                  channelAccountId: account.id,
                  channelAccountEpochId: account.epochId
                },
                event
              )
            ),
            CHANNEL_ADAPTER_START_TIMEOUT_MS,
            "Channel Adapter startup timed out"
          );
          this.#channelAdapterReadiness.set(account.id, adapter.readiness?.() ?? "ready");
        } catch (error) {
          this.#detachChannelAdapter(account.id);
          await adapter.stop().catch(() => undefined);
          throw error;
        }
      })
    );
    return starts.every((result) => result.status === "fulfilled") &&
      accounts.every((account) => this.#channelAdapterReadiness.get(account.id) === "ready");
  }

  async #createChannelAdapter(
    account: ChannelAccountConfiguration,
    resolver: ProfileSecretResolver | undefined
  ): Promise<ChannelAdapter> {
    if (account.provider === "whatsapp") {
      const auth = await this.#dependencies.openWhatsAppAuthState({
        directoryPath: join(this.#config.stateDirectory, "channel-auth", account.id)
      });
      return this.#dependencies.createWhatsAppAdapter({
        channelAccountId: account.id,
        auth: auth.state,
        saveCredentials: auth.saveCredentials
      });
    }
    if (!resolver) throw new Error("QQ Secret Resolver is unavailable");
    const [appId, appSecret] = await Promise.all([
      resolver.resolve(account.appId),
      resolver.resolve(account.appSecret)
    ]);
    return this.#dependencies.createQQAdapter({
      channelAccountId: account.id,
      appId,
      appSecret
    });
  }

  async #acceptChannelEvent(
    context: TrustedChannelContext,
    event: ProviderInboundEvent
  ): Promise<void> {
    const pipeline = this.#inboundPipeline;
    if (!pipeline) throw new Error("Inbound Pipeline is unavailable");
    try {
      const disposition = await pipeline.accept(context, event);
      if (disposition.kind === "observed") {
        this.emit("channelEvent", disposition.event);
        this.#routeObservedChannelEvent(
          disposition.archiveRecordId,
          disposition.event,
          context.channelAccountId
        );
      }
    } catch (error) {
      if (error instanceof InboundPipelineError) {
        const adapter = this.#channelAdapters.get(context.channelAccountId);
        this.#detachChannelAdapter(context.channelAccountId);
        void adapter?.stop();
        this.#transition("degraded", "channel_adapter_unavailable");
        return;
      }
      this.#transition("unavailable", "profile_store_unavailable");
      void this.#stopChannelAdapters();
      throw new Error("Unable to persist Channel event");
    }
  }

  #routeObservedChannelEvent(
    archiveRecordId: string,
    event: InboundChannelEvent,
    channelAccountId: string
  ): void {
    const account = this.#config.channelAccounts?.[channelAccountId];
    if (!account) return;
    const input: ChannelIngressInput = {
      archiveRecordId,
      event,
      accessPolicy: account.accessPolicy,
      groupThreadScope: account.groupThreadScope
    };
    const decision = this.#channelIngress.accept(input);
    this.#emitExpiredChannelWork(decision.expired);
    this.emit("channelIngress", { archiveRecordId, disposition: decision.disposition });
    if (decision.disposition.kind === "start") {
      void this.#executeChannelWork(decision.disposition.work);
    } else if (decision.disposition.kind === "steer") {
      void this.#executeChannelSteer(
        decision.disposition.work,
        decision.disposition.target
      );
    } else if (decision.disposition.kind === "command") {
      void this.#executeChannelCommand(
        decision.disposition.work,
        decision.disposition.command
      );
    }
  }

  async #executeChannelCommand(
    work: ChannelIngressInput,
    command: BridgeCommand
  ): Promise<void> {
    if (command.kind === "approval.respond") {
      const router = this.#serverRequestRouter;
      if (!router) return;
      try {
        await router.respondByToken(
          command.approvalToken,
          {
            profileId: this.#config.profileId,
            channelAccountId: work.event.message.channelAccountId,
            channelAccountEpochId: work.event.message.channelAccountEpochId,
            conversationKey: work.event.message.conversationKey,
            providerIdentity: work.event.message.providerIdentity
          },
          command.decision
        );
        this.emit("channelApprovalResponded", {
          archiveRecordId: work.archiveRecordId,
          approvalToken: command.approvalToken,
          decision: command.decision
        });
      } catch (error) {
        this.emit("channelCommandRejected", {
          archiveRecordId: work.archiveRecordId,
          commandKind: command.kind,
          reason: error instanceof Error ? error.message : "approval_response_failed"
        });
      }
      return;
    }
    if (command.kind !== "turn.stop") {
      this.emit("channelCommandUnsupported", {
        archiveRecordId: work.archiveRecordId,
        commandKind: command.kind
      });
      return;
    }
    const control = this.#channelIngress.activeTurnFor(work);
    if (control.kind !== "allowed") {
      this.emit("channelCommandRejected", {
        archiveRecordId: work.archiveRecordId,
        commandKind: command.kind,
        reason: control.kind === "forbidden" ? "not_turn_initiator" : "no_active_turn"
      });
      return;
    }
    const coordinator = this.#turnCoordinator;
    if (!coordinator) return;
    try {
      await coordinator.interruptTurn(control.target);
      this.emit("channelTurnInterruptRequested", {
        archiveRecordId: work.archiveRecordId,
        target: control.target
      });
    } catch (error) {
      this.emit("channelTurnFailed", {
        archiveRecordId: work.archiveRecordId,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  async #presentChannelApproval(
    approval: import("./codex-server-request-router.js").RoutedApprovalRequest
  ): Promise<void> {
    const account = this.#config.channelAccounts?.[approval.context.channelAccountId];
    const adapter = this.#channelAdapters.get(approval.context.channelAccountId);
    const validTarget =
      account?.enabled === true &&
      account.epochId === approval.context.channelAccountEpochId &&
      adapter !== undefined;
    if (!validTarget) {
      await this.#serverRequestRouter?.cancelUndeliverable(approval.approvalToken);
      this.emit("channelApprovalDeliveryFailed", {
        approvalToken: approval.approvalToken,
        reason: "adapter_unavailable"
      });
      return;
    }
    try {
      const presentation = await this.#channelApprovalTransport.present(approval, adapter);
      this.emit("channelApprovalPresented", presentation);
    } catch (error) {
      if (error instanceof ChannelDeliveryError && error.outcome === "ambiguous") {
        this.emit("channelApprovalDeliveryAmbiguous", {
          approvalToken: approval.approvalToken
        });
        return;
      }
      await this.#serverRequestRouter?.cancelUndeliverable(approval.approvalToken);
      this.emit("channelApprovalDeliveryFailed", {
        approvalToken: approval.approvalToken,
        reason: error instanceof ChannelDeliveryError ? error.outcome : "delivery_exception"
      });
    }
  }

  async #executeChannelSteer(
    work: ChannelIngressInput,
    target: { readonly threadId: string; readonly turnId: string }
  ): Promise<void> {
    const coordinator = this.#conversationTurnCoordinator;
    if (!coordinator) return;
    try {
      const result = await coordinator.steer({
        archiveRecordId: work.archiveRecordId,
        event: work.event,
        groupThreadScope: work.groupThreadScope,
        target
      });
      this.emit("channelTurnSteered", result);
    } catch (error) {
      this.emit("channelTurnFailed", {
        archiveRecordId: work.archiveRecordId,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  async #executeChannelWork(work: ChannelIngressInput): Promise<void> {
    const coordinator = this.#conversationTurnCoordinator;
    if (!coordinator) return;
    try {
      const result = await coordinator.execute({
        archiveRecordId: work.archiveRecordId,
        event: work.event,
        groupThreadScope: work.groupThreadScope,
        onTurnStarted: (target) => this.#channelIngress.markTurnStarted(work.archiveRecordId, target)
      });
      this.emit("channelTurnCompleted", result);
    } catch (error) {
      this.emit("channelTurnFailed", {
        archiveRecordId: work.archiveRecordId,
        error: error instanceof Error ? error : new Error(String(error))
      });
    } finally {
      const release = this.#channelIngress.release(work.archiveRecordId, Date.now());
      this.#emitExpiredChannelWork(release.expired);
      for (const ready of release.ready) void this.#executeChannelWork(ready);
    }
  }

  #emitExpiredChannelWork(
    expired: readonly { readonly workId: string; readonly reason: string }[]
  ): void {
    for (const entry of expired) this.emit("channelWorkExpired", entry);
  }

  async #stopChannelAdapters(): Promise<void> {
    const adapters = [...this.#channelAdapters.values()];
    for (const unsubscribe of this.#channelAdapterUnsubscribe.values()) unsubscribe();
    this.#channelAdapterUnsubscribe.clear();
    this.#channelAdapterReadiness.clear();
    this.#channelAdapters.clear();
    await Promise.allSettled(adapters.map((adapter) => adapter.stop()));
  }

  #detachChannelAdapter(channelAccountId: string): void {
    this.#channelAdapterUnsubscribe.get(channelAccountId)?.();
    this.#channelAdapterUnsubscribe.delete(channelAccountId);
    this.#channelAdapterReadiness.delete(channelAccountId);
    this.#channelAdapters.delete(channelAccountId);
  }

  #refreshChannelAdapterHealth(): void {
    if (this.#health.readiness !== "ready" && this.#health.readiness !== "degraded") return;
    const enabledAccountIds = Object.values(this.#config.channelAccounts ?? {})
      .filter((account) => account.enabled)
      .map((account) => account.id);
    const allReady = enabledAccountIds.every(
      (accountId) => this.#channelAdapterReadiness.get(accountId) === "ready"
    );
    if (!allReady && (
      this.#health.readiness !== "degraded" ||
      this.#health.reason !== "channel_adapter_unavailable"
    )) {
      this.#transition("degraded", "channel_adapter_unavailable");
    } else if (
      allReady &&
      this.#health.readiness === "degraded" &&
      this.#health.reason === "channel_adapter_unavailable"
    ) {
      this.#transition("ready", null);
    }
  }

  #startDeliveryOutbox(): void {
    const store = this.#store;
    if (!store || this.#deliveryOutbox) return;
    this.#deliveryOutbox = new DeliveryOutbox({
      store,
      resolveAdapter: (lease) => {
        const account = this.#config.channelAccounts?.[lease.channelAccountId];
        if (
          !account?.enabled ||
          account.provider !== lease.provider ||
          account.epochId !== lease.channelAccountEpochId
        ) {
          return undefined;
        }
        return this.#channelAdapters.get(lease.channelAccountId);
      }
    });
    this.#scheduleOutboxSweep(0);
  }

  #scheduleOutboxSweep(delayMs: number): void {
    if (!this.#deliveryOutbox || this.#outboxTimer) return;
    this.#outboxTimer = setTimeout(() => {
      this.#outboxTimer = undefined;
      const outbox = this.#deliveryOutbox;
      if (!outbox) return;
      void outbox.deliverReady().then(
        () => this.#scheduleOutboxSweep(OUTBOX_SWEEP_INTERVAL_MS),
        () => {
          this.#transition("unavailable", "profile_store_unavailable");
          void this.#stopChannelAdapters();
        }
      );
    }, delayMs);
    this.#outboxTimer.unref();
  }

  async #stopDeliveryOutbox(): Promise<void> {
    if (this.#outboxTimer) clearTimeout(this.#outboxTimer);
    this.#outboxTimer = undefined;
    const outbox = this.#deliveryOutbox;
    this.#deliveryOutbox = undefined;
    await outbox?.stop();
  }

  #transition(
    readiness: ProfileHealth["readiness"],
    reason: ProfileReasonCode,
    probe?: ProtocolProbeResult
  ): ProfileHealth {
    this.#health = {
      profileId: this.#config.profileId,
      readiness,
      reason,
      ...(probe
        ? { codexVersion: probe.cliVersion, codexVerification: probe.verification }
        : this.#health.codexVersion
          ? {
              codexVersion: this.#health.codexVersion,
              codexVerification: this.#health.codexVerification
            }
          : {})
    };
    this.emit("health", this.health());
    return this.health();
  }
}

async function withRejectingTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
