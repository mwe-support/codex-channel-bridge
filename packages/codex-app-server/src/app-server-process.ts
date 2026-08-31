import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";

import { JsonlRpcClient, ProtocolFaultError } from "./jsonl-rpc-client.js";
import type {
  InitializeParams,
  InitializeResponse,
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest
} from "./protocol.js";

export interface CodexAppServerOptions {
  readonly executable: string;
  readonly codexHome: string;
  readonly workspace: string;
  readonly bridgeVersion: string;
  /**
   * Source environment used to construct the isolated child environment.
   * Production callers should omit this; it exists so the boundary can be
   * tested without mutating the test runner's own process environment.
   */
  readonly processEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly requestTimeoutMs?: number;
  readonly childExitTimeoutMs?: number;
}

export interface StderrSummary {
  readonly bytesObserved: number;
  readonly chunksObserved: number;
  readonly truncated: boolean;
}

export interface CodexRpcRuntime {
  request<TResult>(method: string, params?: unknown): Promise<TResult>;
  notify(method: string, params?: unknown): Promise<void>;
  respond(id: JsonRpcId, result: unknown): Promise<void>;
  respondError(id: JsonRpcId, error: JsonRpcErrorObject): Promise<void>;
  on(event: "notification", listener: (message: JsonRpcNotification) => void): this;
  on(event: "serverRequest", listener: (message: JsonRpcRequest) => void): this;
  on(event: "protocolFault", listener: (error: ProtocolFaultError) => void): this;
  off(event: "notification", listener: (message: JsonRpcNotification) => void): this;
  off(event: "serverRequest", listener: (message: JsonRpcRequest) => void): this;
  off(event: "protocolFault", listener: (error: ProtocolFaultError) => void): this;
  stop(): Promise<void>;
}

export interface ManagedCodexRpcRuntime extends CodexRpcRuntime {
  start(): Promise<InitializeResponse>;
}

export class CodexAppServerProcess extends EventEmitter implements ManagedCodexRpcRuntime {
  readonly #options: CodexAppServerOptions;
  #child?: ChildProcessWithoutNullStreams;
  #rpc?: JsonlRpcClient;
  #stderrBytes = 0;
  #stderrChunks = 0;
  #stderrTruncated = false;
  #stopping = false;
  #faultEmitted = false;

  public constructor(options: CodexAppServerOptions) {
    super();
    this.#options = options;
  }

  public async start(): Promise<InitializeResponse> {
    if (this.#child) throw new Error("Codex App Server process is already started");
    this.#stopping = false;
    this.#faultEmitted = false;
    const child = spawn(this.#options.executable, ["app-server", "--stdio"], {
      cwd: this.#options.workspace,
      env: createCodexChildEnvironment(
        this.#options.processEnvironment ?? process.env,
        this.#options.codexHome
      ),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.#child = child;

    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      this.#stderrChunks += 1;
      this.#stderrBytes = Math.min(this.#stderrBytes + bytes, 1024 * 1024);
      if (this.#stderrBytes === 1024 * 1024) this.#stderrTruncated = true;
    });

    const rpc = new JsonlRpcClient(child.stdout, child.stdin, this.#options.requestTimeoutMs);
    this.#rpc = rpc;
    rpc.on("notification", (message: JsonRpcNotification) => this.emit("notification", message));
    rpc.on("serverRequest", (message: JsonRpcRequest) => this.emit("serverRequest", message));
    rpc.on("protocolFault", (error: ProtocolFaultError) => {
      this.#emitProtocolFault(error);
      if (!child.killed) child.kill("SIGTERM");
    });
    child.once("error", (error) => {
      const fault = new ProtocolFaultError(`Codex App Server process error: ${error.message}`);
      rpc.close(fault);
      if (!this.#stopping) this.#emitProtocolFault(fault);
    });
    child.once("exit", (code, signal) => {
      const fault = new ProtocolFaultError(
        `Codex App Server exited (${code ?? signal ?? "unknown"})`
      );
      rpc.close(fault);
      if (!this.#stopping) this.#emitProtocolFault(fault);
    });

    const params: InitializeParams = {
      clientInfo: {
        name: "codex-channel-bridge",
        title: "Codex Channel Bridge",
        version: this.#options.bridgeVersion
      },
      capabilities: { experimentalApi: false }
    };
    const initialized = await rpc.request<InitializeResponse>("initialize", params);
    await rpc.notify("initialized");
    return initialized;
  }

  public request<TResult>(method: string, params?: unknown): Promise<TResult> {
    return this.#requireRpc().request<TResult>(method, params);
  }

  public notify(method: string, params?: unknown): Promise<void> {
    return this.#requireRpc().notify(method, params);
  }

  public respond(id: JsonRpcId, result: unknown): Promise<void> {
    return this.#requireRpc().respond(id, result);
  }

  public respondError(id: JsonRpcId, error: JsonRpcErrorObject): Promise<void> {
    return this.#requireRpc().respondError(id, error);
  }

  public stderrSummary(): StderrSummary {
    return {
      bytesObserved: this.#stderrBytes,
      chunksObserved: this.#stderrChunks,
      truncated: this.#stderrTruncated
    };
  }

  public async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    this.#rpc?.close(new ProtocolFaultError("Codex App Server stopped by Profile worker"));
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      const exitTimeoutMs = this.#options.childExitTimeoutMs ?? 5_000;
      try {
        await waitWithTimeout(exit, exitTimeoutMs);
      } catch {
        if (child.exitCode === null && child.signalCode === null) {
          const forcedExit = once(child, "exit");
          child.kill("SIGKILL");
          await waitWithTimeout(forcedExit, exitTimeoutMs).catch(() => undefined);
        }
      }
    }
    this.#child = undefined;
    this.#rpc = undefined;
  }

  #emitProtocolFault(error: ProtocolFaultError): void {
    if (this.#faultEmitted) return;
    this.#faultEmitted = true;
    this.emit("protocolFault", error);
  }

  #requireRpc(): JsonlRpcClient {
    if (!this.#rpc) throw new Error("Codex App Server process is not started");
    return this.#rpc;
  }
}

const CODEX_CHILD_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LANGUAGE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR"
]);

/**
 * Build the Profile-local Codex child environment without forwarding Channel
 * secrets, Bridge control variables, or an enclosing Codex Desktop session's
 * tool pipe and permission profile. CODEX_HOME is the only CODEX_* variable
 * the Bridge injects into the child.
 */
export function createCodexChildEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  codexHome: string
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (normalized.startsWith("LC_") || CODEX_CHILD_ENVIRONMENT_KEYS.has(normalized)) {
      child[key] = value;
    }
  }
  return child;
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Codex App Server exit timed out")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
