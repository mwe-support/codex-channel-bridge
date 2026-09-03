import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { AdministrationResponse } from "./protocol.js";

const HELPER_START_TIMEOUT_MS = 30_000;
const HELPER_STOP_TIMEOUT_MS = 5_000;
const MAX_HELPER_OUTPUT_BYTES = 512 * 1024;
const helperScript = fileURLToPath(
  new URL("../../platform/windows/control-pipe-server.ps1", import.meta.url)
);

export class WindowsPipeHost {
  readonly #endpoint: string;
  readonly #onRequest: (
    line: string,
    respond: (response: AdministrationResponse, final: boolean) => Promise<void>
  ) => Promise<void>;
  #child?: ChildProcessWithoutNullStreams;
  #output = "";
  #ready?: () => void;
  #readyFailure?: (error: Error) => void;

  public constructor(
    endpoint: string,
    onRequest: (
      line: string,
      respond: (response: AdministrationResponse, final: boolean) => Promise<void>
    ) => Promise<void>
  ) {
    this.#endpoint = endpoint;
    this.#onRequest = onRequest;
  }

  public async start(): Promise<void> {
    if (this.#child) return;
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error("Windows SystemRoot is unavailable");
    const pipeName = this.#endpoint.slice("\\\\.\\pipe\\".length);
    if (!pipeName || pipeName.includes("\\") || pipeName.includes("/")) {
      throw new Error("Windows control endpoint must name one local pipe");
    }
    const child = spawn(
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperScript,
        "-PipeName",
        pipeName
      ],
      { stdio: "pipe", windowsHide: true }
    );
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consumeOutput(chunk));

    try {
      await new Promise<void>((resolve, reject) => {
        this.#ready = resolve;
        const timer = setTimeout(
          () => reject(new Error("Windows control pipe helper start timed out")),
          HELPER_START_TIMEOUT_MS
        );
        const finish = (error?: Error): void => {
          clearTimeout(timer);
          child.off("error", onError);
          child.off("exit", onExit);
          this.#ready = undefined;
          this.#readyFailure = undefined;
          error ? reject(error) : resolve();
        };
        const onError = (): void => finish(new Error("Windows control pipe helper failed to start"));
        const onExit = (): void => finish(new Error("Windows control pipe helper exited before ready"));
        child.once("error", onError);
        child.once("exit", onExit);
        this.#ready = () => finish();
        this.#readyFailure = (error) => finish(error);
      });
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end("STOP\n");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timer = setTimeout(() => child.kill(), HELPER_STOP_TIMEOUT_MS);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }

  #consumeOutput(chunk: string): void {
    this.#output += chunk;
    if (Buffer.byteLength(this.#output, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
      this.#child?.kill();
      this.#output = "";
      return;
    }
    for (;;) {
      const newline = this.#output.indexOf("\n");
      if (newline === -1) return;
      const line = this.#output.slice(0, newline).replace(/\r$/, "");
      this.#output = this.#output.slice(newline + 1);
      if (line === "READY") {
        this.#ready?.();
        continue;
      }
      if (line === "ERROR\tpipe_already_in_use") {
        this.#readyFailure?.(new Error("Control endpoint is already in use"));
        continue;
      }
      const [kind, id, encoded] = line.split("\t", 3);
      if (kind !== "REQUEST" || !id || !encoded) {
        this.#child?.kill();
        return;
      }
      const request = Buffer.from(encoded, "base64").toString("utf8");
      void this.#onRequest(request, (response, final) => this.#write(id, response, final));
    }
  }

  async #write(id: string, response: AdministrationResponse, final: boolean): Promise<void> {
    const child = this.#child;
    if (!child?.stdin.writable) throw new Error("Windows control pipe helper is unavailable");
    const encoded = Buffer.from(`${JSON.stringify(response)}\n`, "utf8").toString("base64");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`WRITE\t${id}\t${final ? "1" : "0"}\t${encoded}\n`, (error) =>
        error ? reject(error) : resolve()
      );
    });
  }
}
