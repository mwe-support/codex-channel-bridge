import { contentSanitizer, QQBot, type QQBotInboundMessage, type QQBotOptions } from "@tencent-connect/qqbot-nodejs";
import { ApiError, MediaFileType, StreamInputMode, StreamInputState, StreamContentType } from "@tencent-connect/qqbot-nodejs/protocol";

import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type ChannelAnswerFrame,
  type ChannelAnswerFrameReceipt,
  type ChannelAdapterReadiness,
  type ChannelDeliveryReceipt,
  type ChannelTextDelivery,
  type ChannelFileDelivery,
  type ProviderInboundEvent
} from "@codex-channel-bridge/core";
import {
  QQGatewaySessionCoordinator,
  type QQGatewaySessionRepository
} from "./qq-gateway-session.js";

const GROUP_AND_C2C_INTENT = 1 << 25;
const MAX_CHANNEL_TEXT_CHARACTERS = 5_000;
const CONTENT_FREE_LOGGER = {
  info: (): void => undefined,
  error: (): void => undefined,
  warn: (): void => undefined,
  debug: (): void => undefined
};

export interface QQChannelAdapterOptions {
  readonly channelAccountId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly gatewaySessionRepository: QQGatewaySessionRepository;
}

export type QQAdapterReadiness = ChannelAdapterReadiness;

interface QQMessageContext {
  readonly receivedAt: number;
}

interface QQBotClient {
  readonly uploadMedia?: QQBot["uploadMedia"];
  readonly api?: Pick<QQBot["api"], "post">;
  use(...middleware: Parameters<QQBot["use"]>): this;
  on(event: "ready", handler: (data: unknown) => void | Promise<void>): this;
  on(event: "resumed", handler: (data: unknown) => void | Promise<void>): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(
    event: "message",
    handler: (context: QQMessageContext, message: QQBotInboundMessage) => void | Promise<void>
  ): this;
  start(signal?: AbortSignal): Promise<void>;
  stop(): void;
  send(options: Parameters<QQBot["send"]>[0]): ReturnType<QQBot["send"]>;
  sendText(
    target: { scope: "c2c" | "group"; targetId: string; msgId?: string },
    content: string
  ): Promise<{ id: string; timestamp: string | number }>;
}

type QQBotFactory = (options: QQBotOptions) => QQBotClient;

export class QQChannelAdapter implements ChannelAdapter {
  readonly #options: QQChannelAdapterOptions;
  readonly #bot: QQBotClient;
  readonly #gatewaySession: QQGatewaySessionCoordinator;
  #readiness: QQAdapterReadiness = "stopped";
  #run?: Promise<void>;
  #stopping = false;
  readonly #readinessListeners = new Set<(readiness: ChannelAdapterReadiness) => void>();

  public constructor(
    options: QQChannelAdapterOptions,
    botFactory: QQBotFactory = (value) => new QQBot(value) as QQBotClient
  ) {
    validateOptions(options);
    this.#options = options;
    this.#gatewaySession = new QQGatewaySessionCoordinator(
      options.gatewaySessionRepository,
      () => this.#setReadiness("degraded")
    );
    this.#bot = botFactory({
      appId: options.appId,
      appSecret: options.appSecret,
      accountId: options.channelAccountId,
      intents: GROUP_AND_C2C_INTENT,
      logger: CONTENT_FREE_LOGGER,
      tokenPrefetch: "sync",
      transport: "websocket",
      sessionPersistence: this.#gatewaySession.sdkPort
    });
    this.#bot.use(
      async (_context, next) => {
        const checkpoint = this.#gatewaySession.claimMessage();
        await next();
        await this.#gatewaySession.commitMessage(checkpoint);
      },
      contentSanitizer()
    );
  }

  public readiness(): QQAdapterReadiness {
    return this.#readiness;
  }

  public subscribeReadiness(
    listener: (readiness: ChannelAdapterReadiness) => void
  ): () => void {
    this.#readinessListeners.add(listener);
    return () => this.#readinessListeners.delete(listener);
  }

  public async start(onEvent: (event: ProviderInboundEvent) => Promise<void>): Promise<void> {
    if (this.#readiness !== "stopped" || this.#run) {
      throw new Error("QQ Channel Adapter is already started");
    }
    this.#setReadiness("starting");
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let readySettled = false;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const markReady = async (): Promise<void> => {
      try {
        await this.#gatewaySession.commitControl();
        this.#setReadiness("ready");
        if (!readySettled) {
          readySettled = true;
          resolveReady();
        }
      } catch {
        this.#setReadiness("degraded");
        if (!readySettled) {
          readySettled = true;
          rejectReady(new Error("QQ Channel Adapter could not persist its Gateway session"));
        }
        this.#bot.stop();
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
        this.#setReadiness("degraded");
      }
      void error;
    });
    this.#bot.on("message", async (context, message) => {
      const normalized = normalizeQQMessage(context.receivedAt, message);
      if (normalized) await onEvent(normalized);
    });

    await this.#gatewaySession.restore();
    this.#run = this.#bot.start().then(
      () => {
        if (this.#stopping) return;
        this.#setReadiness("degraded");
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
        if (!this.#stopping) this.#setReadiness("degraded");
      }
    );
    await ready;
  }

  public async sendText(delivery: ChannelTextDelivery): Promise<ChannelDeliveryReceipt> {
    if (this.#readiness !== "ready") {
      throw new ChannelDeliveryError("deferred", "QQ Channel Adapter is not ready");
    }
    validateDelivery(delivery);
    const scope = delivery.target.conversationKind === "private" ? "c2c" : "group";
    const targetId = delivery.target.providerConversationId;
    try {
      let response;
      try {
        response = delivery.target.providerReplyEventId
          ? await this.#bot.send({
              target: {
                scope,
                targetId,
                msgId: delivery.target.providerReplyEventId
              },
              msgType: 0,
              content: delivery.text,
              extra: { msg_seq: delivery.providerReplySequence }
            })
          : await this.#bot.sendText({ scope, targetId }, delivery.text);
      } catch (error) {
        if (!delivery.target.providerReplyEventId || !isExpiredReplyAnchor(error)) throw error;
        response = await this.#bot.sendText({ scope, targetId }, delivery.text);
      }
      const acceptedAtMs = parseProviderTime(response.timestamp) ?? Date.now();
      return {
        logicalResultId: delivery.logicalResultId,
        segmentIndex: delivery.segmentIndex,
        outcome: "accepted",
        providerMessageId: response.id,
        acceptedAtMs
      };
    } catch (error) {
      throw mapDeliveryError(error);
    }
  }

  public async sendFile(delivery: ChannelFileDelivery): Promise<ChannelDeliveryReceipt> {
    if (this.#readiness !== "ready") throw new ChannelDeliveryError("deferred", "QQ adapter is not ready");
    validateDelivery({ ...delivery, text: delivery.filename });
    if (!this.#bot.uploadMedia || !delivery.filename || /[/\\\x00-\x1f]/.test(delivery.filename) ||
        !(delivery.bytes instanceof Uint8Array) || !delivery.bytes.length || delivery.bytes.length > 64 * 1024 * 1024) {
      throw new ChannelDeliveryError("rejected", "Invalid or unsupported file delivery");
    }
    const target = {
      scope: delivery.target.conversationKind === "private" ? "c2c" as const : "group" as const,
      targetId: delivery.target.providerConversationId
    };
    try {
      const upload = await this.#bot.uploadMedia({ target, fileType: MediaFileType.FILE,
        buffer: Buffer.from(delivery.bytes), fileName: delivery.filename, srvSendMsg: false });
      if (!upload.file_info) throw new ChannelDeliveryError("deferred", "QQ upload returned no file reference");
      const send = (passive: boolean) => this.#bot.send({
        target: { ...target, ...(passive ? { msgId: delivery.target.providerReplyEventId! } : {}) },
        msgType: 7, media: { file_info: upload.file_info },
        ...(passive ? { extra: { msg_seq: delivery.providerReplySequence } } : {})
      });
      let response;
      try { response = await send(!!delivery.target.providerReplyEventId); }
      catch (error) {
        if (!delivery.target.providerReplyEventId || !isExpiredReplyAnchor(error)) throw error;
        response = await send(false);
      }
      if (!response.id) throw new ChannelDeliveryError("ambiguous", "QQ file send returned no message identifier");
      return { logicalResultId: delivery.logicalResultId, segmentIndex: delivery.segmentIndex,
        outcome: "accepted", providerMessageId: response.id, acceptedAtMs: parseProviderTime(response.timestamp) ?? Date.now() };
    } catch (error) { throw mapDeliveryError(error); }
  }

  public async sendAnswerFrame(frame: ChannelAnswerFrame): Promise<ChannelAnswerFrameReceipt> {
    if (this.#readiness !== "ready") throw new ChannelDeliveryError("deferred", "QQ adapter is not ready");
    if (!this.#bot.api || frame.target.conversationKind !== "private" ||
        !frame.target.providerReplyEventId || !frame.target.providerConversationId ||
        !frame.text || frame.text.length > MAX_CHANNEL_TEXT_CHARACTERS ||
        !Number.isSafeInteger(frame.index) || frame.index < 0 ||
        !Number.isSafeInteger(frame.providerReplySequence) || frame.providerReplySequence < 1 ||
        (frame.index === 0 ? frame.providerMessageId !== undefined : !frame.providerMessageId)) {
      throw new ChannelDeliveryError("rejected", "QQ native stream frame is invalid or unsupported");
    }
    try {
      // SDK 1.0.4's stream helper requires both anchors; the official contract
      // requires one. Its authenticated API gateway preserves the correct body.
      const response = await this.#bot.api.post<{ id: string; timestamp: string | number; remain_msg_len?: unknown }>(
        `/v2/users/${encodeURIComponent(frame.target.providerConversationId)}/stream_messages`,
        { input_mode: StreamInputMode.REPLACE,
          input_state: frame.done ? StreamInputState.DONE : StreamInputState.GENERATING,
          content_type: StreamContentType.MARKDOWN, content_raw: frame.text,
          msg_id: frame.target.providerReplyEventId, msg_seq: frame.providerReplySequence,
          index: frame.index, ...(frame.providerMessageId ? { stream_msg_id: frame.providerMessageId } : {}) }
      );
      if (!response.id) throw new ChannelDeliveryError("ambiguous", "QQ stream receipt has no identity");
      const remaining = (response as { remain_msg_len?: unknown }).remain_msg_len;
      return { providerMessageId: response.id,
        acceptedAtMs: parseProviderTime(response.timestamp) ?? Date.now(),
        ...(typeof remaining === "number" && Number.isSafeInteger(remaining) && remaining >= 0
          ? { remainingCharacters: remaining } : {}) };
    } catch (error) { throw mapDeliveryError(error); }
  }

  public async stop(): Promise<void> {
    if (!this.#run) {
      this.#setReadiness("stopped");
      return;
    }
    this.#stopping = true;
    this.#bot.stop();
    await this.#run.catch(() => undefined);
    await this.#gatewaySession.settled();
    this.#run = undefined;
    this.#setReadiness("stopped");
    this.#stopping = false;
  }

  #setReadiness(readiness: ChannelAdapterReadiness): void {
    if (this.#readiness === readiness) return;
    this.#readiness = readiness;
    for (const listener of this.#readinessListeners) listener(readiness);
  }
}

function normalizeQQMessage(
  receivedAt: number,
  message: QQBotInboundMessage
): ProviderInboundEvent | null {
  if (message.kind !== "c2c" && message.kind !== "group") return null;
  const conversationKind = message.kind === "c2c" ? "private" : "group";
  const providerConversationId =
    message.kind === "c2c" ? message.senderId : message.groupOpenid;
  if (!providerConversationId || !message.messageId || !message.senderId) return null;
  const observedAtMs = parseProviderTime(message.timestamp) ?? receivedAt;
  const mentioned = message.rawEventType === "GROUP_AT_MESSAGE_CREATE" ||
    message.mentions?.some((mention) => mention.is_you === true);
  return {
    message: {
      provider: "qq",
      providerEventId: JSON.stringify([message.messageId, message.msgIdx ?? null]),
      conversationKind,
      providerConversationId,
      providerIdentity: message.senderId,
      observedAtMs,
      // SDK 1.0.4's sanitizer matches AppID, but QQ group routing markers can
      // contain opaque IDs. Remove only leading addressing markup, not commands.
      text: message.kind === "group" && mentioned
        ? message.content.replace(/^(?:<@!?[^>]+>\s*)+/u, "")
        : message.content
    },
    attention:
      message.kind === "c2c"
        ? "direct"
        : mentioned
          ? "mention"
          : "passive",
    replyTarget: {
      conversationKind,
      providerConversationId,
      providerReplyEventId: message.messageId
    },
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment, index) => ({
            providerAttachmentId: String(index),
            contentType: attachment.content_type,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
            ...(attachment.url ? { sourceUrl: attachment.url } : {}),
            ...(attachment.size === undefined ? {} : { declaredSizeBytes: attachment.size }),
            ...(attachment.width === undefined ? {} : { width: attachment.width }),
            ...(attachment.height === undefined ? {} : { height: attachment.height }),
            ...(attachment.asr_refer_text
              ? { transcript: attachment.asr_refer_text }
              : {})
          }))
        }
      : {})
  };
}

function validateOptions(options: QQChannelAdapterOptions): void {
  if (
    !options.channelAccountId.trim() ||
    !options.appId.trim() ||
    !options.appSecret.trim()
  ) {
    throw new Error("QQ Channel Adapter configuration is invalid");
  }
}

function validateDelivery(delivery: ChannelTextDelivery): void {
  const hasReplyAnchor = delivery.target.providerReplyEventId !== undefined;
  if (
    !delivery.logicalResultId.trim() ||
    !Number.isSafeInteger(delivery.segmentIndex) ||
    delivery.segmentIndex < 0 ||
    !delivery.target.providerConversationId.trim() ||
    (hasReplyAnchor && !delivery.target.providerReplyEventId?.trim()) ||
    !delivery.text ||
    delivery.text.length > MAX_CHANNEL_TEXT_CHARACTERS ||
    (hasReplyAnchor
      ? !Number.isSafeInteger(delivery.providerReplySequence) || delivery.providerReplySequence! < 1
      : delivery.providerReplySequence !== undefined)
  ) {
    throw new ChannelDeliveryError("rejected", "QQ message delivery is invalid");
  }
}

const EXPIRED_REPLY_CODES = new Set([304103, 40034005]);

function isExpiredReplyAnchor(error: unknown): boolean {
  return error instanceof ApiError &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500 &&
    error.bizCode !== undefined &&
    EXPIRED_REPLY_CODES.has(error.bizCode);
}

function mapDeliveryError(error: unknown): ChannelDeliveryError {
  if (error instanceof ChannelDeliveryError) return error;
  if (error instanceof ApiError && error.httpStatus === 429) {
    return new ChannelDeliveryError("deferred", "QQ rate limited the message delivery");
  }
  if (
    error instanceof ApiError &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500 &&
    error.httpStatus !== 429
  ) {
    return new ChannelDeliveryError("rejected", "QQ rejected the message delivery");
  }
  return new ChannelDeliveryError("ambiguous", "QQ message delivery outcome is ambiguous");
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
