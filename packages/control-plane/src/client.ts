import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import {
  resolveControlEndpoint,
  verifyUnixControlSocket
} from "./endpoint.js";
import {
  CONTROL_PROTOCOL_VERSION,
  isAdministrationResponse,
  type AdministrationMethod,
  type AdministrationResults
} from "./protocol.js";
import type { WhatsAppChannelAccountEvent } from "@codex-channel-bridge/supervisor";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export class AdministrationResponseError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "AdministrationResponseError";
  }
}

export class ControlPlaneClient {
  readonly #endpoint: string;

  public constructor(endpoint?: string) {
    this.#endpoint = resolveControlEndpoint(endpoint);
  }

  public async request<TMethod extends AdministrationMethod>(
    method: TMethod,
    params?: unknown,
    onEvent?: (event: WhatsAppChannelAccountEvent) => Promise<void> | void
  ): Promise<AdministrationResults[TMethod]> {
    if (process.platform !== "win32") await verifyUnixControlSocket(this.#endpoint);
    const id = randomUUID();
    const socket = createConnection({ path: this.#endpoint });
    socket.setEncoding("utf8");
    socket.setTimeout(330_000, () => socket.destroy(new Error("Control request timed out")));
    let input = "";
    let receivedBytes = 0;
    let settled = false;
    const response = new Promise<AdministrationResults[TMethod]>((resolve, reject) => {
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({
            version: CONTROL_PROTOCOL_VERSION,
            id,
            method,
            ...(params === undefined ? {} : { params })
          })}\n`
        );
      });
      socket.on("data", (chunk: string) => {
        receivedBytes += Buffer.byteLength(chunk, "utf8");
        input += chunk;
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          reject(new Error("Control response exceeded limit"));
          socket.destroy();
          return;
        }
        for (;;) {
          const newline = input.indexOf("\n");
          if (newline === -1) return;
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            reject(new Error("Control response was not JSON"));
            socket.destroy();
            return;
          }
          if (!isAdministrationResponse(value) || value.id !== id) {
            reject(new Error("Control response did not match the request"));
            socket.destroy();
            return;
          }
          if ("event" in value) {
            Promise.resolve(onEvent?.(value.event)).catch(() => undefined);
            continue;
          }
          settled = true;
          if ("error" in value) {
            reject(new AdministrationResponseError(value.error.code, value.error.message, value.error.data));
          } else {
            resolve(value.result as AdministrationResults[TMethod]);
          }
          socket.destroy();
          return;
        }
      });
      socket.once("error", reject);
      socket.once("end", () => {
        if (!settled) reject(new Error("Control connection closed without a final response"));
      });
    });
    return response;
  }
}
