import { contentSanitizer, QQBot, type QQBotInboundMessage, type QQBotOptions } from "@tencent-connect/qqbot-nodejs";
import { ApiError } from "@tencent-connect/qqbot-nodejs/protocol";

import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type ChannelDeliveryReceipt,
  type ChannelTextDelivery,
  type InboundChannelEvent
} from "@codex-channel-bridge/core";

const GROUP_AND_C2C_INTENT = 1 << 25;
const MAX_CHANNEL_TEXT_CHARACTERS = 5_000;
const CONTENT_FREE_LOGGER = {
  info: (): void => undefined,
  error: (): void => undefined,
  warn: (): void => undefined,
  debug: (): void => undefined
};

export interface QQChannelAdapterOptions {
  readonly profileId: string;
  readonly channelAccountId: string;
  readonly channelAccountEpochId: string;
  readonly appId: string;
  readonly appSecret: string;
}

export type QQAdapterReadiness = "stopped" | "starting" | "ready" | "degraded";

interface QQMessageContext {
  readonly receivedAt: number;
}

interface QQBotClient {
  use(...middleware: Parameters<QQBot["use"]>): this;
  on(event: "ready", handler: (data: unknown) => void): this;
  on(event: "resumed", handler: (data: unknown) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(
    event: "message",
    handler: (context: QQMessageContext, message: QQBotInboundMessage) => void | Promise<void>
  ): this;
  start(signal?: AbortSignal): Promise<void>;
  stop(): void;
  sendText(
    target: { scope: "c2c" | "group"; targetId: string; msgId?: string },
    content: string
  ): Promise<{ id: string; timestamp: string | number }>;
}

type QQBotFactory = (options: QQBotOptions) => QQBotClient;

export class QQChannelAdapter implements ChannelAdapter {
  readonly #options: QQChannelAdapterOptions;
  readonly #bot: QQBotClient;
  #readiness: QQAdapterReadiness = "stopped";
  #run?: Promise<void>;
  #stopping = false;

  public constructor(
    options: QQChannelAdapterOptions,
    botFactory: QQBotFactory = (value) => new QQBot(value) as QQBotClient
  ) {
    validateOptions(options);
    this.#options = options;
    this.#bot = botFactory({
      appId: options.appId,
      appSecret: options.appSecret,
      accountId: options.channelAccountId,
      intents: GROUP_AND_C2C_INTENT,
      logger: CONTENT_FREE_LOGGER,
      tokenPrefetch: "sync",
      transport: "websocket"
    });
    this.#bot.use(contentSanitizer());
  }

  public readiness(): QQAdapterReadiness {
    return this.#readiness;
  }

  public async start(onEvent: (event: InboundChannelEvent) => Promise<void>): Promise<void> {
    if (this.#readiness !== "stopped" || this.#run) {
      throw new Error("QQ Channel Adapter is already started");
    }
    this.#readiness = "starting";
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let readySettled = false;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const markReady = (): void => {
      this.#readiness = "ready";
      if (!readySettled) {
        readySettled = true;
        resolveReady();
      }
    };
    this.#bot.on("ready", markReady);
    this.#bot.on("resumed", markReady);
    this.#bot.on("error", (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("QQ Channel Adapter failed before ready"));
        this.#bot.stop();
      } else if (!this.#stopping) {
        this.#readiness = "degraded";
      }
      void error;
    });
    this.#bot.on("message", async (context, message) => {
      const normalized = normalizeQQMessage(this.#options, context.receivedAt, message);
      if (normalized) await onEvent(normalized);
    });

    this.#run = this.#bot.start().then(
      () => {
        if (this.#stopping) return;
        this.#readiness = "degraded";
        if (!readySettled) {
          readySettled = true;
          rejectReady(new Error("QQ Channel Adapter stopped before ready"));
        }
      },
      () => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(new Error("QQ Channel Adapter failed before ready"));
        }
        if (!this.#stopping) this.#readiness = "degraded";
      }
    );
    await ready;
  }

  public async sendText(delivery: ChannelTextDelivery): Promise<ChannelDeliveryReceipt> {
    if (this.#readiness !== "ready") {
      throw new ChannelDeliveryError("rejected", "QQ Channel Adapter is not ready");
    }
    validateDelivery(delivery);
    try {
      const response = await this.#bot.sendText(
        {
          scope: delivery.target.conversationKind === "private" ? "c2c" : "group",
          targetId: delivery.target.providerConversationId,
          ...(delivery.target.providerReplyEventId
            ? { msgId: delivery.target.providerReplyEventId }
            : {})
        },
        delivery.text
      );
      const acceptedAtMs = parseProviderTime(response.timestamp) ?? Date.now();
      return {
        logicalResultId: delivery.logicalResultId,
        segmentIndex: delivery.segmentIndex,
        outcome: "accepted",
        providerMessageId: response.id,
        acceptedAtMs
      };
    } catch (error) {
      if (error instanceof ChannelDeliveryError) throw error;
      if (error instanceof ApiError && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 429) {
        throw new ChannelDeliveryError("rejected", "QQ rejected the message delivery");
      }
      throw new ChannelDeliveryError("ambiguous", "QQ message delivery outcome is ambiguous");
    }
  }

  public async stop(): Promise<void> {
    if (!this.#run) {
      this.#readiness = "stopped";
      return;
    }
    this.#stopping = true;
    this.#bot.stop();
    await this.#run.catch(() => undefined);
    this.#run = undefined;
    this.#readiness = "stopped";
    this.#stopping = false;
  }
}

function normalizeQQMessage(
  options: QQChannelAdapterOptions,
  receivedAt: number,
  message: QQBotInboundMessage
): InboundChannelEvent | null {
  if (message.kind !== "c2c" && message.kind !== "group") return null;
  const conversationKind = message.kind === "c2c" ? "private" : "group";
  const providerConversationId =
    message.kind === "c2c" ? message.senderId : message.groupOpenid;
  if (!providerConversationId || !message.messageId || !message.senderId) return null;
  const observedAtMs = parseProviderTime(message.timestamp) ?? receivedAt;
  const conversationKey = [
    "qq",
    encodeURIComponent(options.channelAccountId),
    conversationKind,
    encodeURIComponent(providerConversationId)
  ].join(":");
  return {
    message: {
      profileId: options.profileId,
      provider: "qq",
      channelAccountId: options.channelAccountId,
      channelAccountEpochId: options.channelAccountEpochId,
      providerEventId: JSON.stringify([message.messageId, message.msgIdx ?? null]),
      conversationKey,
      conversationKind,
      providerIdentity: message.senderId,
      observedAtMs,
      text: message.content
    },
    attention:
      message.kind === "c2c"
        ? "direct"
        : message.rawEventType === "GROUP_AT_MESSAGE_CREATE"
          ? "mention"
          : "passive",
    replyTarget: {
      conversationKey,
      conversationKind,
      providerConversationId,
      providerReplyEventId: message.messageId
    }
  };
}

function validateOptions(options: QQChannelAdapterOptions): void {
  if (
    !options.profileId.trim() ||
    !options.channelAccountId.trim() ||
    !options.channelAccountEpochId.trim() ||
    !options.appId.trim() ||
    !options.appSecret.trim()
  ) {
    throw new Error("QQ Channel Adapter configuration is invalid");
  }
}

function validateDelivery(delivery: ChannelTextDelivery): void {
  if (
    !delivery.logicalResultId.trim() ||
    !Number.isSafeInteger(delivery.segmentIndex) ||
    delivery.segmentIndex < 0 ||
    !delivery.target.providerConversationId.trim() ||
    !delivery.text ||
    delivery.text.length > MAX_CHANNEL_TEXT_CHARACTERS
  ) {
    throw new ChannelDeliveryError("rejected", "QQ message delivery is invalid");
  }
}

function parseProviderTime(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type { QQBotClient, QQBotFactory };
export { normalizeQQMessage };
