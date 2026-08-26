import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";

import {
  CodexAppServerProcess,
  CodexProtocolProbeError,
  type CodexAppServerOptions,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type ManagedCodexRpcRuntime,
  type ProtocolProbeResult,
  type ThreadStartResponse,
  type TurnStartResponse,
  probeCodexProtocol
} from "@codex-channel-bridge/codex-app-server";
import type { ProfileHealth, ProfileReasonCode } from "@codex-channel-bridge/core";

export interface ProfileWorkerConfig {
  readonly profileId: string;
  readonly workspace: string;
  readonly codexHome: string;
  readonly codexExecutable?: string;
}

export interface TurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: string;
  readonly finalText: string;
}

export interface ProfileWorkerDependencies {
  readonly probe: (executable: string) => Promise<ProtocolProbeResult>;
  readonly createRuntime: (options: CodexAppServerOptions) => ManagedCodexRpcRuntime;
}

const defaultDependencies: ProfileWorkerDependencies = {
  probe: (executable) => probeCodexProtocol(executable),
  createRuntime: (options) => new CodexAppServerProcess(options)
};

export class ProfileUnavailableError extends Error {
  public constructor(public readonly health: ProfileHealth) {
    super(`Profile ${health.profileId} is ${health.readiness}: ${health.reason ?? "no reason"}`);
    this.name = "ProfileUnavailableError";
  }
}

export class ProfileWorker extends EventEmitter {
  readonly #config: ProfileWorkerConfig;
  readonly #dependencies: ProfileWorkerDependencies;
  #runtime?: ManagedCodexRpcRuntime;
  #health: ProfileHealth;

  public constructor(
    config: ProfileWorkerConfig,
    dependencies: ProfileWorkerDependencies = defaultDependencies
  ) {
    super();
    this.#config = config;
    this.#dependencies = dependencies;
    this.#health = {
      profileId: config.profileId,
      readiness: "stopped",
      reason: null
    };
  }

  public health(): ProfileHealth {
    return { ...this.#health };
  }

  public async start(): Promise<ProfileHealth> {
    if (!this.#isValidConfiguration()) {
      return this.#transition("unavailable", "invalid_profile_configuration");
    }
    if (this.#runtime) return this.health();
    this.#transition("starting", null);
    const executable = this.#config.codexExecutable ?? "codex";

    let probe: ProtocolProbeResult;
    try {
      probe = await this.#dependencies.probe(executable);
    } catch (error) {
      const reason =
        error instanceof CodexProtocolProbeError ? error.reason : ("codex_start_failed" as const);
      return this.#transition("unavailable", reason);
    }

    const runtime = this.#dependencies.createRuntime({
      executable,
      codexHome: this.#config.codexHome,
      workspace: this.#config.workspace,
      bridgeVersion: "0.1.0-dev"
    });
    this.#runtime = runtime;
    runtime.on("notification", (message) => this.emit("notification", message));
    runtime.on("serverRequest", (request) => this.#handleServerRequest(request));
    runtime.on("protocolFault", () => {
      this.#transition("unavailable", "protocol_fault", probe);
    });

    try {
      await runtime.start();
      await runtime.request("model/list", {});
    } catch {
      await runtime.stop().catch(() => undefined);
      this.#runtime = undefined;
      return this.#transition("unavailable", "codex_start_failed", probe);
    }

    return this.#transition("ready", null, probe);
  }

  public async runTurn(text: string, existingThreadId?: string): Promise<TurnResult> {
    const runtime = this.#requireReadyRuntime();
    const threadId = existingThreadId ?? (await this.#startThread(runtime));
    const earlyNotifications: JsonRpcNotification[] = [];
    const agentMessages: string[] = [];
    let turnId: string | undefined;
    let resolveCompletion!: (value: { status: string }) => void;
    let rejectCompletion!: (reason: Error) => void;
    const completion = new Promise<{ status: string }>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const processNotification = (message: JsonRpcNotification): void => {
      if (!turnId) {
        if (earlyNotifications.length < 1_000) earlyNotifications.push(message);
        return;
      }
      const params = asRecord(message.params);
      if (!params || params.threadId !== threadId || params.turnId !== turnId) {
        if (message.method !== "turn/completed") return;
        const turn = asRecord(params?.turn);
        if (!turn || turn.id !== turnId || params?.threadId !== threadId) return;
      }

      if (message.method === "item/completed") {
        const item = asRecord(params.item);
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          agentMessages.push(item.text);
        }
      }
      if (message.method === "turn/completed") {
        const turn = asRecord(params.turn);
        resolveCompletion({ status: typeof turn?.status === "string" ? turn.status : "unknown" });
      }
    };

    runtime.on("notification", processNotification);
    try {
      const response = await runtime.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        clientUserMessageId: randomUUID()
      });
      turnId = response.turn.id;
      for (const message of earlyNotifications) processNotification(message);
      const terminal = await withTimeout(
        completion,
        30 * 60_000,
        () => rejectCompletion(new Error("Timed out waiting for turn/completed"))
      );
      return {
        threadId,
        turnId,
        status: terminal.status,
        finalText: agentMessages.join("\n\n")
      };
    } finally {
      runtime.off("notification", processNotification);
    }
  }

  public async stop(): Promise<ProfileHealth> {
    const runtime = this.#runtime;
    if (!runtime) return this.#transition("stopped", null);
    this.#transition("draining", null);
    await runtime.stop();
    this.#runtime = undefined;
    return this.#transition("stopped", null);
  }

  async #startThread(runtime: ManagedCodexRpcRuntime): Promise<string> {
    const response = await runtime.request<ThreadStartResponse>("thread/start", {
      cwd: this.#config.workspace
    });
    return response.thread.id;
  }

  #requireReadyRuntime(): ManagedCodexRpcRuntime {
    if (this.#health.readiness !== "ready" || !this.#runtime) {
      throw new ProfileUnavailableError(this.health());
    }
    return this.#runtime;
  }

  #handleServerRequest(request: JsonRpcRequest): void {
    if (this.emit("serverRequest", request)) return;
    void this.#runtime
      ?.respondError(request.id, {
        code: -32601,
        message: "No Channel approval or user-input handler is attached"
      })
      .catch(() => this.#transition("unavailable", "protocol_fault"));
  }

  #isValidConfiguration(): boolean {
    return (
      this.#config.profileId.trim().length > 0 &&
      isAbsolute(this.#config.workspace) &&
      isAbsolute(this.#config.codexHome)
    );
  }

  #transition(
    readiness: ProfileHealth["readiness"],
    reason: ProfileReasonCode,
    probe?: ProtocolProbeResult
  ): ProfileHealth {
    this.#health = {
      profileId: this.#config.profileId,
      readiness,
      reason,
      ...(probe
        ? { codexVersion: probe.cliVersion, codexVerification: probe.verification }
        : this.#health.codexVersion
          ? {
              codexVersion: this.#health.codexVersion,
              codexVerification: this.#health.codexVerification
            }
          : {})
    };
    this.emit("health", this.health());
    return this.health();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref();
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}
