import { createServer, type Server, type Socket } from "node:net";

import { ConfigurationValidationError } from "@codex-channel-bridge/config";

import { AdministrationError, type AdministrationHandler } from "./administration.js";
import {
  prepareUnixControlEndpoint,
  removeUnixControlSocket,
  resolveControlEndpoint,
  secureUnixControlSocket
} from "./endpoint.js";
import {
  CONTROL_PROTOCOL_VERSION,
  isAdministrationRequest,
  type AdministrationErrorResponse,
  type AdministrationRequest,
  type AdministrationResponse
} from "./protocol.js";

const MAX_REQUEST_BYTES = 256 * 1024;

export type AdministrationRole = "system_administrator";

export interface RequestAuthorizer {
  authorize(socket: Socket, request: AdministrationRequest): Promise<AdministrationRole | null>;
}

export interface ControlPlaneServerOptions {
  readonly endpoint?: string;
  readonly handler: AdministrationHandler;
  readonly authorizer?: RequestAuthorizer;
}

const ownerEndpointAuthorizer: RequestAuthorizer = {
  authorize: async () => "system_administrator"
};

export class ControlPlaneServer {
  readonly #endpoint: string;
  readonly #handler: AdministrationHandler;
  readonly #authorizer: RequestAuthorizer;
  readonly #sockets = new Set<Socket>();
  #server?: Server;

  public constructor(options: ControlPlaneServerOptions) {
    this.#endpoint = resolveControlEndpoint(options.endpoint);
    this.#handler = options.handler;
    this.#authorizer = options.authorizer ?? ownerEndpointAuthorizer;
  }

  public endpoint(): string {
    return this.#endpoint;
  }

  public async start(): Promise<void> {
    if (this.#server) return;
    if (process.platform !== "win32") await prepareUnixControlEndpoint(this.#endpoint);
    const server = createServer({ allowHalfOpen: false }, (socket) => this.#accept(socket));
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          { path: this.#endpoint, readableAll: false, writableAll: false },
          () => {
            server.off("error", reject);
            resolve();
          }
        );
      });
      if (process.platform !== "win32") await secureUnixControlSocket(this.#endpoint);
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const socket of this.#sockets) socket.destroy();
    await closed;
    if (process.platform !== "win32") await removeUnixControlSocket(this.#endpoint);
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.setTimeout(330_000, () => socket.destroy());
    let input = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        void this.#respondError(socket, "unknown", "request_too_large", "Request exceeded limit");
        return;
      }
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      if (input.slice(newline + 1).trim().length > 0) {
        void this.#respondError(socket, "unknown", "multiple_requests", "One request per connection");
        return;
      }
      void this.#handleLine(socket, input.slice(0, newline));
    });
    socket.on("error", () => undefined);
  }

  async #handleLine(socket: Socket, line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      await this.#respondError(socket, "unknown", "invalid_json", "Request must be JSON");
      return;
    }
    if (!isAdministrationRequest(value)) {
      await this.#respondError(socket, "unknown", "invalid_request", "Request shape is invalid");
      return;
    }
    let role: AdministrationRole | null;
    try {
      role = await this.#authorizer.authorize(socket, value);
    } catch {
      await this.#respondError(socket, value.id, "forbidden", "Operation is not authorized");
      return;
    }
    if (role !== "system_administrator") {
      await this.#respondError(socket, value.id, "forbidden", "Operation is not authorized");
      return;
    }
    try {
      const result = await this.#handler.handle(value, (event) =>
        writeEvent(socket, { version: CONTROL_PROTOCOL_VERSION, id: value.id, event })
      );
      await writeResponse(socket, {
        version: CONTROL_PROTOCOL_VERSION,
        id: value.id,
        result
      });
    } catch (error) {
      const response = errorResponse(value.id, error);
      await writeResponse(socket, response);
    }
  }

  async #respondError(socket: Socket, id: string, code: string, message: string): Promise<void> {
    await writeResponse(socket, {
      version: CONTROL_PROTOCOL_VERSION,
      id,
      error: { code, message }
    });
  }
}

async function writeEvent(
  socket: Socket,
  response: Extract<AdministrationResponse, { readonly event: unknown }>
): Promise<void> {
  if (socket.destroyed || !socket.writable) throw new Error("Control connection closed");
  await new Promise<void>((resolve, reject) => {
    socket.write(`${JSON.stringify(response)}\n`, (error) => error ? reject(error) : resolve());
  });
}

function errorResponse(id: string, error: unknown): AdministrationErrorResponse {
  if (error instanceof AdministrationError) {
    return {
      version: CONTROL_PROTOCOL_VERSION,
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data })
      }
    };
  }
  if (error instanceof ConfigurationValidationError) {
    return {
      version: CONTROL_PROTOCOL_VERSION,
      id,
      error: {
        code: "invalid_configuration",
        message: error.message,
        data: { issues: error.issues }
      }
    };
  }
  return {
    version: CONTROL_PROTOCOL_VERSION,
    id,
    error: { code: "internal_error", message: "Administration operation failed" }
  };
}

async function writeResponse(socket: Socket, response: AdministrationResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    socket.end(`${JSON.stringify(response)}\n`, resolve);
  });
}
