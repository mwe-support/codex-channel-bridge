import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type ChannelAdapterReadiness,
  type ChannelDeliveryReceipt,
  type ChannelTextDelivery,
  type ChannelFileDelivery,
  type ChannelReplyTarget,
  type ProviderInboundEvent
} from "@codex-channel-bridge/core";
import { isAbsolute } from "node:path";

import {
  clearBaileysAuthRevocationState,
  forgetBaileysAuthState,
  markBaileysAuthRevocationUncertain,
  openActiveBaileysAuthState,
  readActiveBaileysProviderIdentity,
  readBaileysAuthRevocationState
} from "./baileys-auth-state.js";
import {
  WhatsAppChannelAdapter,
  type BaileysSocketFactory
} from "./whatsapp-adapter.js";
import {
  pairWhatsAppAccount,
  type WhatsAppPairingMaterial,
  type WhatsAppPairingSocketFactory
} from "./whatsapp-pairing.js";

export type WhatsAppChannelAccountAction =
  | { readonly kind: "connect" }
  | { readonly kind: "disconnect" }
  | { readonly kind: "pair"; readonly timeoutMs?: number }
  | { readonly kind: "logout" }
  | { readonly kind: "forget_local"; readonly confirmChannelAccountId: string };

export type WhatsAppChannelAccountEvent = {
  readonly kind: "pairing_material";
  readonly material: WhatsAppPairingMaterial;
};

export type WhatsAppChannelAccountResult =
  | { readonly kind: "connected" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "paired"; readonly generationId: string }
  | { readonly kind: "logout_uncertain" }
  | { readonly kind: "local_auth_forgotten" };

export interface WhatsAppChannelAccountOptions {
  readonly channelAccountId: string;
  readonly rootDirectoryPath: string;
  readonly reconnectDelaysMs?: readonly number[];
  readonly random?: () => number;
  /** True-external Baileys seam used by production and deterministic tests. */
  readonly socketFactory?: BaileysSocketFactory;
  /** True-external pairing Socket seam used by production and deterministic tests. */
  readonly pairingSocketFactory?: WhatsAppPairingSocketFactory;
}

/**
 * Deep account lifecycle module. Callers see one Channel Adapter plus one typed
 * action interface; Auth Generation, pairing, reconnect locks, logout
 * uncertainty, and single-adapter replacement remain local implementation.
 */
export class WhatsAppChannelAccount implements ChannelAdapter {
  readonly #options: WhatsAppChannelAccountOptions;
  readonly #readinessListeners = new Set<(readiness: ChannelAdapterReadiness) => void>();
  #adapter?: WhatsAppChannelAdapter;
  #unsubscribe?: () => void;
  #onInbound?: (event: ProviderInboundEvent) => Promise<void>;
  #readiness: ChannelAdapterReadiness = "stopped";
  #desiredConnected = false;
  #operation: Promise<unknown> = Promise.resolve();

  public constructor(options: WhatsAppChannelAccountOptions) {
    if (!options.channelAccountId.trim() || !isAbsolute(options.rootDirectoryPath)) {
      throw new Error("WhatsApp Channel Account configuration is invalid");
    }
    this.#options = options;
  }

  public readiness(): ChannelAdapterReadiness {
    return this.#readiness;
  }

  public subscribeReadiness(
    listener: (readiness: ChannelAdapterReadiness) => void
  ): () => void {
    this.#readinessListeners.add(listener);
    return () => this.#readinessListeners.delete(listener);
  }

  public async start(onEvent: (event: ProviderInboundEvent) => Promise<void>): Promise<void> {
    if (this.#onInbound) throw new Error("WhatsApp Channel Account is already started");
    this.#onInbound = onEvent;
    this.#desiredConnected = true;
    this.#setReadiness("starting");
    await this.#connect(false).catch(() => this.#setReadiness("degraded"));
  }

  public async sendText(delivery: ChannelTextDelivery): Promise<ChannelDeliveryReceipt> {
    const adapter = this.#adapter;
    if (!adapter) {
      throw new ChannelDeliveryError("deferred", "WhatsApp Channel Account is not connected");
    }
    return adapter.sendText(delivery);
  }

  public async sendFile(delivery: ChannelFileDelivery): Promise<ChannelDeliveryReceipt> {
    const adapter = this.#adapter;
    if (!adapter) throw new ChannelDeliveryError("deferred", "WhatsApp Channel Account is not connected");
    return adapter.sendFile(delivery);
  }

  public execute(
    action: WhatsAppChannelAccountAction,
    onEvent: (event: WhatsAppChannelAccountEvent) => Promise<void> | void = () => undefined
  ): Promise<WhatsAppChannelAccountResult> {
    const operation = this.#operation.then(() => this.#execute(action, onEvent));
    this.#operation = operation.catch(() => undefined);
    return operation;
  }

  public startTyping(target: ChannelReplyTarget): (() => void) | undefined {
    return this.#adapter?.startTyping(target);
  }

  public async stop(): Promise<void> {
    await this.#operation.catch(() => undefined);
    this.#desiredConnected = false;
    await this.#stopAdapter();
    this.#onInbound = undefined;
    this.#setReadiness("stopped");
  }

  async #execute(
    action: WhatsAppChannelAccountAction,
    onEvent: (event: WhatsAppChannelAccountEvent) => Promise<void> | void
  ): Promise<WhatsAppChannelAccountResult> {
    if (!this.#onInbound) throw new Error("WhatsApp Channel Account is not supervised");
    if (action.kind === "connect") {
      this.#desiredConnected = true;
      await this.#connect(false);
      return { kind: "connected" };
    }
    if (action.kind === "disconnect") {
      this.#desiredConnected = false;
      await this.#stopAdapter();
      this.#setReadiness("degraded");
      return { kind: "disconnected" };
    }
    if (action.kind === "pair") return this.#pair(action.timeoutMs, onEvent);
    if (action.kind === "logout") return this.#logout();
    if (action.confirmChannelAccountId !== this.#options.channelAccountId) {
      throw new Error("Complete Channel Account ID confirmation did not match");
    }
    if (
      await readBaileysAuthRevocationState({
        rootDirectoryPath: this.#options.rootDirectoryPath
      }) !== "uncertain"
    ) {
      throw new Error("Local authentication can be forgotten only after uncertain revocation");
    }
    this.#desiredConnected = false;
    await this.#stopAdapter();
    await forgetBaileysAuthState({ rootDirectoryPath: this.#options.rootDirectoryPath });
    this.#setReadiness("degraded");
    return { kind: "local_auth_forgotten" };
  }

  async #pair(
    timeoutMs: number | undefined,
    onEvent: (event: WhatsAppChannelAccountEvent) => Promise<void> | void
  ): Promise<WhatsAppChannelAccountResult> {
    if (
      await readBaileysAuthRevocationState({
        rootDirectoryPath: this.#options.rootDirectoryPath
      }) === "uncertain"
    ) {
      throw new Error("WhatsApp authentication revocation is uncertain");
    }
    const expectedProviderIdentity = await this.#activeIdentity();
    await this.#stopAdapter();
    try {
      const result = await pairWhatsAppAccount({
        rootDirectoryPath: this.#options.rootDirectoryPath,
        ...(expectedProviderIdentity ? { expectedProviderIdentity } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(this.#options.pairingSocketFactory
          ? { socketFactory: this.#options.pairingSocketFactory }
          : {}),
        onPairingMaterial: (material) => onEvent({ kind: "pairing_material", material })
      });
      await clearBaileysAuthRevocationState({
        rootDirectoryPath: this.#options.rootDirectoryPath
      });
      this.#desiredConnected = true;
      await this.#connect(false);
      return { kind: "paired", generationId: result.generationId };
    } catch (error) {
      if (this.#desiredConnected) await this.#connect(false).catch(() => undefined);
      throw error;
    }
  }

  async #logout(): Promise<WhatsAppChannelAccountResult> {
    this.#desiredConnected = false;
    if (!this.#adapter) await this.#connect(true);
    const adapter = this.#adapter;
    if (!adapter) throw new Error("WhatsApp Channel Account could not connect for logout");
    await markBaileysAuthRevocationUncertain({
      rootDirectoryPath: this.#options.rootDirectoryPath
    });
    try {
      await adapter.requestLogout();
    } catch (error) {
      await clearBaileysAuthRevocationState({
        rootDirectoryPath: this.#options.rootDirectoryPath
      }).catch(() => undefined);
      throw error;
    } finally {
      await this.#stopAdapter();
      this.#setReadiness("degraded");
    }
    return { kind: "logout_uncertain" };
  }

  async #connect(allowRevocationUncertain: boolean): Promise<void> {
    if (this.#adapter?.readiness() === "ready") return;
    if (
      !allowRevocationUncertain &&
      await readBaileysAuthRevocationState({
        rootDirectoryPath: this.#options.rootDirectoryPath
      }) === "uncertain"
    ) {
      throw new Error("WhatsApp authentication revocation is uncertain");
    }
    const inbound = this.#onInbound;
    if (!inbound) throw new Error("WhatsApp Channel Account is not supervised");
    const auth = await openActiveBaileysAuthState({
      rootDirectoryPath: this.#options.rootDirectoryPath
    });
    const adapter = new WhatsAppChannelAdapter(
      {
        channelAccountId: this.#options.channelAccountId,
        auth: auth.state,
        saveCredentials: auth.saveCredentials,
        ...(this.#options.reconnectDelaysMs
          ? { reconnectDelaysMs: this.#options.reconnectDelaysMs }
          : {}),
        ...(this.#options.random ? { random: this.#options.random } : {})
      },
      this.#options.socketFactory
    );
    this.#adapter = adapter;
    this.#unsubscribe = adapter.subscribeReadiness((readiness) => {
      if (this.#adapter !== adapter) return;
      this.#setReadiness(readiness);
    });
    try {
      await adapter.start(inbound);
      this.#setReadiness(adapter.readiness());
    } catch (error) {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#adapter = undefined;
      await adapter.stop().catch(() => undefined);
      this.#setReadiness("degraded");
      throw error;
    }
  }

  async #stopAdapter(): Promise<void> {
    const adapter = this.#adapter;
    this.#adapter = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await adapter?.stop().catch(() => undefined);
  }

  async #activeIdentity(): Promise<string | undefined> {
    try {
      return await readActiveBaileysProviderIdentity({
        rootDirectoryPath: this.#options.rootDirectoryPath
      }) ?? undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (
        message.includes("real directory") ||
        message.includes("generation is missing") ||
        message.includes("credentials are missing")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  #setReadiness(readiness: ChannelAdapterReadiness): void {
    if (this.#readiness === readiness) return;
    this.#readiness = readiness;
    for (const listener of this.#readinessListeners) listener(readiness);
  }
}
