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
    params?: unknown
  ): Promise<AdministrationResults[TMethod]> {
    if (process.platform !== "win32") await verifyUnixControlSocket(this.#endpoint);
    const id = randomUUID();
    const socket = createConnection({ path: this.#endpoint });
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy(new Error("Control request timed out")));
    let input = "";
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
        input += chunk;
        if (Buffer.byteLength(input, "utf8") > MAX_RESPONSE_BYTES) {
          reject(new Error("Control response exceeded limit"));
          socket.destroy();
          return;
        }
        const newline = input.indexOf("\n");
        if (newline === -1) return;
        let value: unknown;
        try {
          value = JSON.parse(input.slice(0, newline));
        } catch {
          reject(new Error("Control response was not JSON"));
          socket.destroy();
          return;
        }
        if (!isAdministrationResponse(value) || value.id !== id) {
          reject(new Error("Control response did not match the request"));
        } else if ("error" in value) {
          reject(new AdministrationResponseError(value.error.code, value.error.message, value.error.data));
        } else {
          resolve(value.result as AdministrationResults[TMethod]);
        }
        socket.destroy();
      });
      socket.once("error", reject);
      socket.once("end", () => {
        if (input.length === 0) reject(new Error("Control connection closed without a response"));
      });
    });
    return response;
  }
}
