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
  readonly requestTimeoutMs?: number;
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

  public constructor(options: CodexAppServerOptions) {
    super();
    this.#options = options;
  }

  public async start(): Promise<InitializeResponse> {
    if (this.#child) throw new Error("Codex App Server process is already started");
    const child = spawn(this.#options.executable, ["app-server", "--stdio"], {
      cwd: this.#options.workspace,
      env: { ...process.env, CODEX_HOME: this.#options.codexHome },
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
      this.emit("protocolFault", error);
      if (!child.killed) child.kill("SIGTERM");
    });
    child.once("error", (error) => rpc.close(error));
    child.once("exit", (code, signal) => {
      rpc.close(new ProtocolFaultError(`Codex App Server exited (${code ?? signal ?? "unknown"})`));
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
    this.#rpc?.close(new ProtocolFaultError("Codex App Server stopped by Profile worker"));
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      try {
        await waitWithTimeout(exit, 5_000);
      } catch {
        if (child.exitCode === null && child.signalCode === null) {
          const forcedExit = once(child, "exit");
          child.kill("SIGKILL");
          await forcedExit;
        }
      }
    }
    this.#child = undefined;
    this.#rpc = undefined;
  }

  #requireRpc(): JsonlRpcClient {
    if (!this.#rpc) throw new Error("Codex App Server process is not started");
    return this.#rpc;
  }
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
