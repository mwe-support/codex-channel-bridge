import makeWASocket, {
  areJidsSameUser,
  downloadMediaMessage,
  DisconnectReason,
  jidNormalizedUser,
  normalizeMessageContent,
  type UserFacingSocketConfig,
  type WAMessage
} from "baileys";

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

const MAX_CHANNEL_TEXT_CHARACTERS = 65_536;
const CONTENT_FREE_LOGGER = {
  level: "silent",
  child: () => CONTENT_FREE_LOGGER,
  trace: (): void => undefined,
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined
};

export interface WhatsAppInboundMessage {
  readonly key: {
    readonly fromMe?: boolean | null;
    readonly id?: string | null;
    readonly remoteJid?: string | null;
    readonly participant?: string | null;
    readonly participantAlt?: string | null;
  };
  readonly messageTimestamp?: number | { toNumber(): number } | null;
  readonly message?: unknown;
}

export type WhatsAppMediaDownloader = (
  message: WhatsAppInboundMessage
) => Promise<AsyncIterable<Uint8Array>>;

export interface BaileysSocketConfiguration {
  readonly auth: unknown;
  readonly logger: unknown;
  readonly emitOwnEvents: false;
  readonly markOnlineOnConnect: false;
  readonly syncFullHistory: false;
  readonly shouldSyncHistoryMessage: () => false;
}

export interface AdapterSocket {
  readonly ev: {
    on(event: "connection.update", handler: (value: {
      connection?: "open" | "connecting" | "close";
      lastDisconnect?: { readonly error?: unknown };
    }) => void): void;
    on(event: "creds.update", handler: (value: unknown) => void): void;
    on(event: "messages.upsert", handler: (value: {
      readonly type: string;
      readonly requestId?: string;
      readonly messages: readonly WhatsAppInboundMessage[];
    }) => void): void;
  };
  readonly user?: {
    readonly id?: string | null;
    readonly lid?: string | null;
  };
  sendMessage(
    jid: string,
    content: { readonly text: string } | { readonly document: Buffer; readonly mimetype: string; readonly fileName: string },
    options?: { readonly quoted: WhatsAppQuotedMessage }
  ): Promise<{
    readonly key: { readonly id?: string | null };
  } | undefined>;
  sendPresenceUpdate(type: "composing" | "paused", jid: string): Promise<void>;
  logout(message?: string): Promise<void>;
  end(error: Error | undefined): Promise<void>;
}

export interface WhatsAppQuotedMessage {
  readonly key: {
    readonly id: string;
    readonly remoteJid: string;
    readonly fromMe: false;
    readonly participant?: string;
  };
  readonly participant?: string;
  readonly message: { readonly conversation: string };
}

export type BaileysSocketFactory = (config: BaileysSocketConfiguration) => AdapterSocket;
export type WhatsAppAdapterReadiness = ChannelAdapterReadiness;

export interface WhatsAppChannelAdapterOptions {
  readonly channelAccountId: string;
  readonly auth: object;
  readonly saveCredentials: () => Promise<void>;
  /** Retry delays after an unexpected close. Empty disables reconnect. */
  readonly reconnectDelaysMs?: readonly number[];
  /** Test seam for deterministic jitter. Production uses Math.random. */
  readonly random?: () => number;
}

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const NON_RETRYABLE_DISCONNECT_REASONS = new Set<number>([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.connectionReplaced,
  DisconnectReason.multideviceMismatch,
  DisconnectReason.forbidden
]);

export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly #typing = new Map<string, { users: number; timer?: ReturnType<typeof setInterval>; refresh: () => void }>();
  readonly #options: WhatsAppChannelAdapterOptions;
  readonly #socketFactory: BaileysSocketFactory;
  #socket?: AdapterSocket;
  #readiness: WhatsAppAdapterReadiness = "stopped";
  #stopping = false;
  #generation = 0;
  #reconnectAttempt = 0;
  #reconnectAbort?: AbortController;
  #onEvent?: (event: ProviderInboundEvent) => Promise<void>;
  #initialReady?: {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    settled: boolean;
  };
  readonly #readinessListeners = new Set<(readiness: ChannelAdapterReadiness) => void>();

  public constructor(
    options: WhatsAppChannelAdapterOptions,
    socketFactory: BaileysSocketFactory = (config) =>
      makeWASocket(config as UserFacingSocketConfig) as AdapterSocket
  ) {
    if (!options.channelAccountId.trim()) {
      throw new Error("WhatsApp Channel Adapter configuration is invalid");
    }
    const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    if (delays.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 60_000)) {
      throw new Error("WhatsApp reconnect delays are invalid");
    }
    this.#options = options;
    this.#socketFactory = socketFactory;
  }

  public readiness(): WhatsAppAdapterReadiness {
    return this.#readiness;
  }

  public subscribeReadiness(
    listener: (readiness: ChannelAdapterReadiness) => void
  ): () => void {
    this.#readinessListeners.add(listener);
    return () => this.#readinessListeners.delete(listener);
  }

  public async start(onEvent: (event: ProviderInboundEvent) => Promise<void>): Promise<void> {
    if (this.#socket || this.#readiness !== "stopped") {
      throw new Error("WhatsApp Channel Adapter is already started");
    }
    this.#setReadiness("starting");
    this.#stopping = false;
    this.#reconnectAttempt = 0;
    this.#onEvent = onEvent;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#initialReady = { resolve: resolveReady, reject: rejectReady, settled: false };
    this.#openSocket();
    await ready;
  }

  #openSocket(): void {
    if (this.#stopping) return;
    const generation = ++this.#generation;
    let socket: AdapterSocket;
    try {
      socket = this.#socketFactory({
        auth: this.#options.auth,
        logger: CONTENT_FREE_LOGGER,
        emitOwnEvents: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false
      });
    } catch {
      this.#scheduleReconnect(generation, undefined);
      return;
    }
    this.#socket = socket;
    socket.ev.on("connection.update", (update) => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      if (update.connection === "open") {
        this.#setReadiness("ready");
        this.#reconnectAttempt = 0;
        this.#settleInitialReady();
      } else if (update.connection === "close" && !this.#stopping) {
        this.#socket = undefined;
        this.#setReadiness("degraded");
        this.#scheduleReconnect(generation, disconnectStatusCode(update.lastDisconnect?.error));
      }
    });
    socket.ev.on("creds.update", () => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      void this.#options.saveCredentials().catch(() => {
        this.#setReadiness("degraded");
        void socket
          .end(new Error("WhatsApp authentication state could not be persisted"))
          .catch(() => undefined);
      });
    });
    socket.ev.on("messages.upsert", (upsert) => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      if (upsert.type !== "notify" || upsert.requestId !== undefined) return;
      const receivedAtMs = Date.now();
      for (const message of upsert.messages) {
        const event = normalizeWhatsAppMessage(
          message,
          [socket.user?.id, socket.user?.lid].filter(
            (jid): jid is string => typeof jid === "string"
          ),
          receivedAtMs
        );
        if (event) {
          void this.#onEvent?.(event).catch(() => {
            this.#setReadiness("degraded");
            void socket.end(new Error("WhatsApp inbound event could not be accepted")).catch(
              () => undefined
            );
          });
        }
      }
    });
  }

  #scheduleReconnect(generation: number, statusCode: number | undefined): void {
    if (generation !== this.#generation || this.#stopping) return;
    if (statusCode !== undefined && NON_RETRYABLE_DISCONNECT_REASONS.has(statusCode)) {
      this.#failInitialReady("WhatsApp authentication requires administrator action");
      return;
    }
    const delays = this.#options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    if (this.#reconnectAttempt >= delays.length) {
      this.#failInitialReady("WhatsApp reconnect attempts were exhausted");
      return;
    }
    const baseDelayMs = statusCode === DisconnectReason.restartRequired
      ? 0
      : delays[this.#reconnectAttempt]!;
    this.#reconnectAttempt += 1;
    const abort = new AbortController();
    this.#reconnectAbort?.abort();
    this.#reconnectAbort = abort;
    const delayMs = boundedJitter(baseDelayMs, this.#options.random ?? Math.random);
    void waitForDelay(delayMs, abort.signal).then((elapsed) => {
      if (!elapsed || abort !== this.#reconnectAbort || this.#stopping) return;
      this.#reconnectAbort = undefined;
      this.#openSocket();
    });
  }

  #settleInitialReady(): void {
    if (!this.#initialReady?.settled) {
      this.#initialReady!.settled = true;
      this.#initialReady!.resolve();
    }
  }

  #failInitialReady(message: string): void {
    this.#setReadiness("degraded");
    if (!this.#initialReady?.settled) {
      this.#initialReady!.settled = true;
      this.#initialReady!.reject(new Error(message));
    }
  }

  public async sendText(delivery: ChannelTextDelivery): Promise<ChannelDeliveryReceipt> {
    return this.#send(delivery, { text: delivery.text });
  }

  public async sendFile(delivery: ChannelFileDelivery): Promise<ChannelDeliveryReceipt> {
    if (!delivery.filename || /[/\\\x00-\x1f]/.test(delivery.filename) ||
        !(delivery.bytes instanceof Uint8Array) || !delivery.bytes.length || delivery.bytes.length > 64 * 1024 * 1024) {
      throw new ChannelDeliveryError("rejected", "Invalid file delivery");
    }
    return this.#send({ ...delivery, text: delivery.filename }, {
      document: Buffer.from(delivery.bytes), mimetype: "application/octet-stream", fileName: delivery.filename
    });
  }

  async #send(delivery: ChannelTextDelivery, content: Parameters<AdapterSocket["sendMessage"]>[1]): Promise<ChannelDeliveryReceipt> {
    const socket = this.#socket;
    if (!socket || this.#readiness !== "ready") {
      throw new ChannelDeliveryError("deferred", "WhatsApp Channel Adapter is not ready");
    }
    validateDelivery(delivery);
    try {
      const response = await socket.sendMessage(
        delivery.target.providerConversationId,
        content,
        quotedMessage(delivery)
      );
      const providerMessageId = response?.key.id;
      if (!providerMessageId) {
        throw new ChannelDeliveryError(
          "ambiguous",
          "WhatsApp send returned no provider message identifier"
        );
      }
      return {
        logicalResultId: delivery.logicalResultId,
        segmentIndex: delivery.segmentIndex,
        outcome: "accepted",
        providerMessageId,
        acceptedAtMs: Date.now()
      };
    } catch (error) {
      if (error instanceof ChannelDeliveryError) throw error;
      throw new ChannelDeliveryError("ambiguous", "WhatsApp delivery outcome is ambiguous");
    }
  }

  public startTyping(target: ChannelReplyTarget): (() => void) | undefined {
    const socket = this.#socket;
    if (!socket || this.#readiness !== "ready") return undefined;
    validateDelivery({ target, logicalResultId: "typing", segmentIndex: 0, text: "typing" });
    const jid = target.providerConversationId;
    let entry = this.#typing.get(jid);
    if (!entry) {
      // At most one in-flight presence per chat; no queue even if the SDK stalls.
      if (this.#typing.size >= 64) return undefined;
      let pending = false;
      const current = { users: 0, timer: undefined as ReturnType<typeof setInterval> | undefined, refresh: (): void => {
        if (pending || this.#typing.get(jid) !== current || this.#socket !== socket) return;
        pending = true;
        const type = current.users > 0 ? "composing" : "paused";
        void (async () => {
          try {
            await socket.sendPresenceUpdate(type, jid);
          } catch {
            clearInterval(current.timer);
            if (this.#typing.get(jid) === current) this.#typing.delete(jid);
          } finally {
            pending = false;
            if (this.#typing.get(jid) === current) {
              if (type === "paused" && current.users === 0) this.#typing.delete(jid);
              else if ((type === "composing") !== (current.users > 0)) current.refresh();
            }
          }
        })();
      } };
      entry = current;
      this.#typing.set(jid, entry);
    }
    entry.users += 1;
    entry.timer ??= setInterval(entry.refresh, 5_000);
    entry.timer.unref();
    entry.refresh();
    let stopped = false;
    return () => {
      if (stopped || this.#typing.get(jid) !== entry) return;
      stopped = true;
      if (--entry.users === 0) {
        clearInterval(entry.timer);
        entry.timer = undefined;
        entry.refresh();
      }
    };
  }

  /**
   * Ask Baileys to remove this companion device. The pinned implementation
   * provides no remote-confirmation receipt, so a successful call is still
   * deliberately reported as uncertain to the account lifecycle module.
   */
  public async requestLogout(): Promise<"uncertain"> {
    const socket = this.#socket;
    if (!socket || this.#readiness !== "ready") {
      throw new Error("WhatsApp Channel Adapter is not ready for logout");
    }
    this.#stopping = true;
    this.#reconnectAbort?.abort();
    this.#reconnectAbort = undefined;
    try {
      await socket.logout("Codex Channel Bridge administrator logout");
    } catch {
      this.#stopping = false;
      throw new Error("WhatsApp logout request could not be sent");
    }
    this.#generation += 1;
    this.#socket = undefined;
    this.#setReadiness("degraded");
    this.#stopping = false;
    return "uncertain";
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    this.#generation += 1;
    this.#reconnectAbort?.abort();
    this.#reconnectAbort = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket) {
      this.#failInitialReady("WhatsApp Channel Adapter stopped before ready");
      this.#onEvent = undefined;
      this.#setReadiness("stopped");
      this.#stopping = false;
      return;
    }
    await socket.end(undefined).catch(() => undefined);
    this.#failInitialReady("WhatsApp Channel Adapter stopped before ready");
    this.#onEvent = undefined;
    this.#stopping = false;
    this.#setReadiness("stopped");
  }

  #setReadiness(readiness: ChannelAdapterReadiness): void {
    if (readiness !== "ready") {
      for (const entry of this.#typing.values()) clearInterval(entry.timer);
      this.#typing.clear();
    }
    if (this.#readiness === readiness) return;
    this.#readiness = readiness;
    for (const listener of this.#readinessListeners) listener(readiness);
  }
}

function quotedMessage(
  delivery: ChannelTextDelivery
): { readonly quoted: WhatsAppQuotedMessage } | undefined {
  const target = delivery.target;
  if (!target.providerReplyEventId || target.providerReplyText === undefined) return undefined;
  const participant = target.providerReplyParticipantId;
  const quoted = {
    key: {
      id: target.providerReplyEventId,
      remoteJid: target.providerConversationId,
      fromMe: false as const,
      ...(target.conversationKind === "group" && participant ? { participant } : {})
    },
    ...(participant ? { participant } : {}),
    message: { conversation: target.providerReplyText }
  };
  return { quoted };
}

function disconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    readonly statusCode?: unknown;
    readonly output?: { readonly statusCode?: unknown };
    readonly data?: { readonly statusCode?: unknown };
  };
  const value = candidate.output?.statusCode ?? candidate.data?.statusCode ?? candidate.statusCode;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedJitter(baseDelayMs: number, random: () => number): number {
  if (baseDelayMs === 0) return 0;
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.round(baseDelayMs * (0.9 + normalized * 0.2));
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function normalizeWhatsAppMessage(
  message: WhatsAppInboundMessage,
  selfJids: string | readonly string[] | undefined,
  receivedAtMs: number,
  downloadMedia: WhatsAppMediaDownloader = async (value) =>
    downloadMediaMessage(value as WAMessage, "stream", {})
): ProviderInboundEvent | null {
  if (message.key.fromMe || !message.key.id || !message.key.remoteJid) return null;
  const remoteJid = normalizeJid(message.key.remoteJid);
  const isGroup = remoteJid.endsWith("@g.us");
  const isPrivate = remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid");
  if (!isGroup && !isPrivate) return null;
  const participant = isGroup
    ? normalizeJid(message.key.participant ?? message.key.participantAlt)
    : remoteJid;
  if (!participant) return null;
  const content = normalizeMessageContent(message.message as WAMessage["message"]);
  const text = extractText(content);
  const attachment = extractMediaAttachment(message, content, downloadMedia);
  const ownJids = typeof selfJids === "string" ? [selfJids] : selfJids ?? [];
  const mentioned = extractMentions(content).some((mentionedJid) =>
    ownJids.some((ownJid) => areJidsSameUser(mentionedJid, ownJid))
  );
  return {
    message: {
      provider: "whatsapp",
      providerEventId: JSON.stringify([remoteJid, isGroup ? participant : null, message.key.id]),
      conversationKind: isGroup ? "group" : "private",
      providerConversationId: remoteJid,
      providerIdentity: participant,
      observedAtMs: providerTimestampMs(message.messageTimestamp) ?? receivedAtMs,
      text
    },
    attention: isGroup ? (mentioned ? "mention" : "passive") : "direct",
    replyTarget: {
      conversationKind: isGroup ? "group" : "private",
      providerConversationId: remoteJid,
      providerReplyEventId: message.key.id
    },
    ...(attachment ? { attachments: [attachment] } : {})
  };
}

function extractMediaAttachment(
  message: WhatsAppInboundMessage,
  content: ReturnType<typeof normalizeMessageContent>,
  downloadMedia: WhatsAppMediaDownloader
) {
  const media = content?.imageMessage ??
    content?.videoMessage ??
    content?.audioMessage ??
    content?.documentMessage ??
    content?.stickerMessage;
  if (!media) return undefined;
  let opened = false;
  const declaredSizeBytes = safeLong(media.fileLength);
  const width = safeLong("width" in media ? media.width : undefined);
  const height = safeLong("height" in media ? media.height : undefined);
  const filename = "fileName" in media && typeof media.fileName === "string"
    ? media.fileName
    : undefined;
  return {
    providerAttachmentId: "media-0",
    contentType: media.mimetype ?? "application/octet-stream",
    ...(filename ? { filename } : {}),
    ...(declaredSizeBytes === undefined ? {} : { declaredSizeBytes }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    contentSource: {
      openStream: async (): Promise<AsyncIterable<Uint8Array>> => {
        if (opened) throw new Error("WhatsApp media source was already opened");
        opened = true;
        return downloadMedia(message);
      }
    }
  };
}

function normalizeJid(jid: string | null | undefined): string {
  if (!jid) return "";
  return jid.endsWith("@g.us") ? jid : jidNormalizedUser(jid);
}

function extractText(content: ReturnType<typeof normalizeMessageContent>): string | null {
  return content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    content?.documentMessage?.caption ??
    null;
}

function extractMentions(content: ReturnType<typeof normalizeMessageContent>): readonly string[] {
  const context = content?.extendedTextMessage?.contextInfo ??
    content?.imageMessage?.contextInfo ??
    content?.videoMessage?.contextInfo ??
    content?.documentMessage?.contextInfo;
  return context?.mentionedJid?.filter((jid): jid is string => typeof jid === "string") ?? [];
}

function providerTimestampMs(value: WhatsAppInboundMessage["messageTimestamp"]): number | null {
  if (value === null || value === undefined) return null;
  const seconds = typeof value === "number" ? value : value.toNumber();
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function safeLong(value: number | { toNumber(): number } | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : value.toNumber();
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function validateDelivery(delivery: ChannelTextDelivery): void {
  const jid = delivery.target.providerConversationId;
  if (
    !delivery.logicalResultId.trim() ||
    !Number.isSafeInteger(delivery.segmentIndex) ||
    delivery.segmentIndex < 0 ||
    (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid") && !jid.endsWith("@g.us")) ||
    !delivery.text ||
    delivery.text.length > MAX_CHANNEL_TEXT_CHARACTERS
  ) {
    throw new ChannelDeliveryError("rejected", "WhatsApp message delivery is invalid");
  }
}
