import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type {
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest
} from "./protocol.js";

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class RpcResponseError extends Error {
  public constructor(
    public readonly rpcError: JsonRpcErrorObject,
    public readonly requestMethod: string
  ) {
    super(`${requestMethod} failed (${rpcError.code}): ${rpcError.message}`);
    this.name = "RpcResponseError";
  }
}

export class ProtocolFaultError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProtocolFaultError";
  }
}

export class JsonlRpcClient extends EventEmitter {
  readonly #writer: Writable;
  readonly #reader: ReadLineInterface;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #requestTimeoutMs: number;
  #nextRequestId = 1;
  #closed = false;

  public constructor(output: Readable, input: Writable, requestTimeoutMs = 30_000) {
    super();
    this.#writer = input;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#reader = createInterface({ input: output, crlfDelay: Infinity });
    this.#reader.on("line", (line) => this.#handleLine(line));
    this.#reader.on("close", () => {
      if (!this.#closed) {
        this.#fault(new ProtocolFaultError("Codex App Server stdout closed"));
      }
    });
  }

  public async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    this.#assertOpen();
    const id = this.#nextRequestId++;
    let settle!: PendingRequest;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ProtocolFaultError(`Timed out waiting for ${method}`));
      }, this.#requestTimeoutMs);
      timer.unref();
      settle = { method, resolve, reject, timer };
    });
    this.#pending.set(id, settle);

    try {
      await this.#write({ id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(asError(error));
      }
    }

    return response as Promise<TResult>;
  }

  public async notify(method: string, params?: unknown): Promise<void> {
    this.#assertOpen();
    await this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  public async respond(id: JsonRpcId, result: unknown): Promise<void> {
    this.#assertOpen();
    await this.#write({ id, result });
  }

  public async respondError(id: JsonRpcId, error: JsonRpcErrorObject): Promise<void> {
    this.#assertOpen();
    await this.#write({ id, error });
  }

  public close(reason = new ProtocolFaultError("JSONL client closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reader.close();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #handleLine(line: string): void {
    if (this.#closed) return;
    if (line.length === 0) {
      this.#fault(new ProtocolFaultError("Blank line on protocol-only stdout"));
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#fault(new ProtocolFaultError("Non-JSON data on protocol-only stdout"));
      return;
    }

    if (!isRecord(message)) {
      this.#fault(new ProtocolFaultError("Protocol message must be a JSON object"));
      return;
    }

    if (typeof message.method === "string") {
      if (isJsonRpcId(message.id)) {
        this.emit("serverRequest", message as unknown as JsonRpcRequest);
      } else if (!("id" in message)) {
        this.emit("notification", message as unknown as JsonRpcNotification);
      } else {
        this.#fault(new ProtocolFaultError("Protocol request has an invalid id"));
      }
      return;
    }

    if (isJsonRpcId(message.id) && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#fault(new ProtocolFaultError("Response id does not match a pending request"));
        return;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if ("error" in message) {
        if (!isRpcError(message.error)) {
          pending.reject(new ProtocolFaultError("Malformed JSON-RPC error response"));
          return;
        }
        pending.reject(new RpcResponseError(message.error, pending.method));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.#fault(new ProtocolFaultError("Unrecognized JSONL protocol message"));
  }

  #fault(error: ProtocolFaultError): void {
    this.emit("protocolFault", error);
    this.close(error);
  }

  async #write(message: object): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.#writer.write(line, (error) => (error ? reject(error) : resolve()));
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new ProtocolFaultError("JSONL client is closed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

function isRpcError(value: unknown): value is JsonRpcErrorObject {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    Number.isInteger(value.code) &&
    typeof value.message === "string"
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
