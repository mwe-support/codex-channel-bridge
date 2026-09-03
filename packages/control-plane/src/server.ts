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
import { WindowsPipeHost } from "./windows-pipe-host.js";

const MAX_REQUEST_BYTES = 256 * 1024;

export type AdministrationRole = "system_administrator";

export interface RequestAuthorizer {
  authorize(request: AdministrationRequest): Promise<AdministrationRole | null>;
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
  #windowsHost?: WindowsPipeHost;

  public constructor(options: ControlPlaneServerOptions) {
    this.#endpoint = resolveControlEndpoint(options.endpoint);
    this.#handler = options.handler;
    this.#authorizer = options.authorizer ?? ownerEndpointAuthorizer;
  }

  public endpoint(): string {
    return this.#endpoint;
  }

  public async start(): Promise<void> {
    if (this.#server || this.#windowsHost) return;
    if (process.platform === "win32") {
      const host = new WindowsPipeHost(this.#endpoint, (line, respond) => this.#handleLine(line, respond));
      this.#windowsHost = host;
      try {
        await host.start();
      } catch (error) {
        this.#windowsHost = undefined;
        throw error;
      }
      return;
    }
    await prepareUnixControlEndpoint(this.#endpoint);
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
      await secureUnixControlSocket(this.#endpoint);
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    const windowsHost = this.#windowsHost;
    if (windowsHost) {
      this.#windowsHost = undefined;
      await windowsHost.stop();
    }
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
        void this.#respondError(socketWriter(socket), "unknown", "request_too_large", "Request exceeded limit");
        return;
      }
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      if (input.slice(newline + 1).trim().length > 0) {
        void this.#respondError(socketWriter(socket), "unknown", "multiple_requests", "One request per connection");
        return;
      }
      void this.#handleLine(input.slice(0, newline), socketWriter(socket));
    });
    socket.on("error", () => undefined);
  }

  async #handleLine(
    line: string,
    respond: (response: AdministrationResponse, final: boolean) => Promise<void>
  ): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      await this.#respondError(respond, "unknown", "invalid_json", "Request must be JSON");
      return;
    }
    if (!isAdministrationRequest(value)) {
      await this.#respondError(respond, "unknown", "invalid_request", "Request shape is invalid");
      return;
    }
    let role: AdministrationRole | null;
    try {
      role = await this.#authorizer.authorize(value);
    } catch {
      await this.#respondError(respond, value.id, "forbidden", "Operation is not authorized");
      return;
    }
    if (role !== "system_administrator") {
      await this.#respondError(respond, value.id, "forbidden", "Operation is not authorized");
      return;
    }
    try {
      const result = await this.#handler.handle(value, (event) =>
        respond({ version: CONTROL_PROTOCOL_VERSION, id: value.id, event }, false)
      );
      await respond({
        version: CONTROL_PROTOCOL_VERSION,
        id: value.id,
        result
      }, true);
    } catch (error) {
      const response = errorResponse(value.id, error);
      await respond(response, true);
    }
  }

  async #respondError(
    respond: (response: AdministrationResponse, final: boolean) => Promise<void>,
    id: string,
    code: string,
    message: string
  ): Promise<void> {
    await respond({
      version: CONTROL_PROTOCOL_VERSION,
      id,
      error: { code, message }
    }, true);
  }
}

function socketWriter(
  socket: Socket
): (response: AdministrationResponse, final: boolean) => Promise<void> {
  return async (response, final) => {
    if (socket.destroyed || !socket.writable) throw new Error("Control connection closed");
    await new Promise<void>((resolve, reject) => {
      const callback = (error?: Error | null): void => error ? reject(error) : resolve();
      if (final) socket.end(`${JSON.stringify(response)}\n`, callback);
      else socket.write(`${JSON.stringify(response)}\n`, callback);
    });
  };
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
