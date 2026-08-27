import makeWASocket, {
  areJidsSameUser,
  DisconnectReason,
  jidNormalizedUser,
  type UserFacingSocketConfig
} from "baileys";

import {
  activateBaileysAuthGeneration,
  createStagedBaileysAuthState,
  discardBaileysAuthGeneration,
  openActiveBaileysAuthState
} from "./baileys-auth-state.js";

const CONTENT_FREE_LOGGER = {
  level: "silent",
  child: () => CONTENT_FREE_LOGGER,
  trace: (): void => undefined,
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined
};

export interface WhatsAppPairingMaterial {
  readonly kind: "qr";
  /** Sensitive, short-lived value. Callers must display it only to the initiating CLI. */
  readonly value: string;
  readonly expiresAtMs: number;
}

export interface WhatsAppPairingResult {
  readonly generationId: string;
  /** Sensitive provider identity; never log or audit the raw value. */
  readonly providerIdentity: string;
  readonly previousGenerationId: string | null;
}

export interface WhatsAppPairingSocket {
  readonly ev: {
    on(event: "connection.update", handler: (value: {
      readonly connection?: "open" | "connecting" | "close";
      readonly qr?: string;
      readonly lastDisconnect?: { readonly error?: unknown };
    }) => void): void;
    on(event: "creds.update", handler: (value: unknown) => void): void;
  };
  readonly user?: { readonly id?: string | null };
  end(error: Error | undefined): Promise<void>;
}

export type WhatsAppPairingSocketFactory = (config: {
  readonly auth: object;
  readonly logger: unknown;
  readonly emitOwnEvents: false;
  readonly markOnlineOnConnect: false;
  readonly syncFullHistory: false;
  readonly shouldSyncHistoryMessage: () => false;
}) => WhatsAppPairingSocket;

export interface WhatsAppPairingOptions {
  readonly rootDirectoryPath: string;
  readonly expectedProviderIdentity?: string;
  readonly onPairingMaterial: (material: WhatsAppPairingMaterial) => Promise<void> | void;
  readonly timeoutMs?: number;
  readonly pairingMaterialLifetimeMs?: number;
  readonly signal?: AbortSignal;
  readonly socketFactory?: WhatsAppPairingSocketFactory;
  readonly now?: () => number;
}

/**
 * Run one explicit pairing attempt against a staged generation. The caller is
 * responsible for ensuring the live adapter is drained before invoking this.
 */
export async function pairWhatsAppAccount(
  options: WhatsAppPairingOptions
): Promise<WhatsAppPairingResult> {
  const timeoutMs = boundedDuration(options.timeoutMs ?? 120_000, "pairing timeout");
  const materialLifetimeMs = boundedDuration(
    options.pairingMaterialLifetimeMs ?? 60_000,
    "pairing material lifetime"
  );
  if (options.signal?.aborted) throw new Error("WhatsApp pairing was cancelled");
  const staged = await createStagedBaileysAuthState({
    rootDirectoryPath: options.rootDirectoryPath
  });
  const factory = options.socketFactory ?? ((config) =>
    makeWASocket(config as UserFacingSocketConfig) as WhatsAppPairingSocket);
  const now = options.now ?? (() => Date.now());
  let socket: WhatsAppPairingSocket | undefined;
  let generation = 0;
  let restartCount = 0;
  let settled = false;
  let activationStarted = false;
  let materialTail = Promise.resolve();

  let resolveResult!: (result: WhatsAppPairingResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<WhatsAppPairingResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const fail = (message: string): void => {
    if (settled) return;
    settled = true;
    rejectResult(new Error(message));
  };
  const openSocket = (): void => {
    if (settled) return;
    const currentGeneration = ++generation;
    try {
      socket = factory({
        auth: staged.state,
        logger: CONTENT_FREE_LOGGER,
        emitOwnEvents: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false
      });
    } catch {
      fail("WhatsApp pairing Socket could not start");
      return;
    }
    const currentSocket = socket;
    currentSocket.ev.on("creds.update", () => {
      if (settled || currentGeneration !== generation || currentSocket !== socket) return;
      void staged.saveCredentials().catch(() => fail("WhatsApp pairing state could not be persisted"));
    });
    currentSocket.ev.on("connection.update", (update) => {
      if (settled || currentGeneration !== generation || currentSocket !== socket) return;
      if (update.qr) {
        const material: WhatsAppPairingMaterial = {
          kind: "qr",
          value: update.qr,
          expiresAtMs: now() + materialLifetimeMs
        };
        materialTail = materialTail
          .then(() => options.onPairingMaterial(material))
          .then(() => undefined, () => fail("WhatsApp pairing material could not be presented"));
      }
      if (update.connection === "open") {
        const providerIdentity = normalizeProviderIdentity(currentSocket.user?.id);
        if (!providerIdentity) {
          fail("WhatsApp pairing did not prove a Provider Identity");
          return;
        }
        if (
          options.expectedProviderIdentity &&
          !areJidsSameUser(providerIdentity, options.expectedProviderIdentity)
        ) {
          fail("WhatsApp pairing Provider Identity did not match the Channel Account");
          return;
        }
        void materialTail
          .then(async () => {
            if (settled) return null;
            activationStarted = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            await staged.saveCredentials();
            return activateBaileysAuthGeneration({
              rootDirectoryPath: options.rootDirectoryPath,
              generationId: staged.generationId
            });
          })
          .then((activation) => {
            if (settled || !activation) return;
            settled = true;
            resolveResult({
              generationId: staged.generationId,
              providerIdentity,
              previousGenerationId: activation.previousGenerationId
            });
          }, () => fail("WhatsApp pairing state could not be activated"));
      } else if (update.connection === "close") {
        if (activationStarted) return;
        const statusCode = disconnectStatusCode(update.lastDisconnect?.error);
        if (statusCode === DisconnectReason.restartRequired && restartCount < 2) {
          restartCount += 1;
          socket = undefined;
          openSocket();
        } else {
          fail("WhatsApp pairing connection closed before identity verification");
        }
      }
    });
  };

  const timer = setTimeout(() => {
    if (!activationStarted) fail("WhatsApp pairing timed out");
  }, timeoutMs);
  timer.unref();
  const onAbort = (): void => {
    if (!activationStarted) fail("WhatsApp pairing was cancelled");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  openSocket();

  try {
    return await result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    generation += 1;
    await socket?.end(undefined).catch(() => undefined);
    if (!settled || !(await isGenerationActive(options.rootDirectoryPath, staged.generationId))) {
      await discardBaileysAuthGeneration({
        rootDirectoryPath: options.rootDirectoryPath,
        generationId: staged.generationId
      }).catch(() => undefined);
    }
  }
}

function normalizeProviderIdentity(value: string | null | undefined): string {
  if (!value) return "";
  return jidNormalizedUser(value);
}

function disconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    readonly statusCode?: unknown;
    readonly output?: { readonly statusCode?: unknown };
  };
  const value = candidate.output?.statusCode ?? candidate.statusCode;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 10 * 60_000) {
    throw new Error(`WhatsApp ${name} is invalid`);
  }
  return value;
}

async function isGenerationActive(rootDirectoryPath: string, generationId: string): Promise<boolean> {
  try {
    return (await openActiveBaileysAuthState({ rootDirectoryPath })).generationId === generationId;
  } catch {
    return false;
  }
}
