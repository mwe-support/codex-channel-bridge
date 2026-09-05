import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { ProfileConfiguration, SupervisorConfiguration } from "@codex-channel-bridge/config";
import type { ProfileHealth } from "@codex-channel-bridge/core";
import {
  type ModelAction,
  type CodexCircuitResetResult,
  isWorkerToSupervisorMessage,
  type SupervisorToWorkerMessage,
  type WhatsAppChannelAccountAction,
  type WhatsAppChannelAccountEvent,
  type WhatsAppChannelAccountResult,
  type WorkerToSupervisorMessage
} from "@codex-channel-bridge/profile-worker";

export interface ProfileRuntime {
  start(): Promise<ProfileHealth>;
  stop(): Promise<ProfileHealth>;
  health(): ProfileHealth;
  subscribe(listener: (health: ProfileHealth) => void): () => void;
  executeWhatsAppAccountAction(
    channelAccountId: string,
    action: WhatsAppChannelAccountAction,
    onEvent?: (event: WhatsAppChannelAccountEvent) => Promise<void> | void
  ): Promise<WhatsAppChannelAccountResult>;
  resetCodexCircuit(): Promise<CodexCircuitResetResult>;
  executeModelAction(action: ModelAction): Promise<Record<string, unknown>>;
}

export class ProfileRuntimeActionError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProfileRuntimeActionError";
  }
}

export interface ProfileRuntimeFactory {
  create(
    profile: ProfileConfiguration,
    supervisor: SupervisorConfiguration
  ): ProfileRuntime;
}

export class ForkedProfileRuntimeFactory implements ProfileRuntimeFactory {
  public create(
    profile: ProfileConfiguration,
    supervisor: SupervisorConfiguration
  ): ProfileRuntime {
    return new ForkedProfileRuntime(
      profile,
      supervisor.drainTimeoutMs,
      supervisor.childExitTimeoutMs,
      supervisor.codexRestartCooldownMs,
      supervisor.diskSafetyFloorBytes
    );
  }
}

class ForkedProfileRuntime implements ProfileRuntime {
  readonly #profile: ProfileConfiguration;
  readonly #drainTimeoutMs: number;
  readonly #childExitTimeoutMs: number;
  readonly #supervisorCodexRestartCooldownMs: number;
  readonly #diskSafetyFloorBytes: number;
  readonly #listeners = new Set<(health: ProfileHealth) => void>();
  #child?: ChildProcess;
  #health: ProfileHealth;
  #expectedExit = false;
  readonly #pendingActions = new Map<string, {
    readonly resolve: (result: WhatsAppChannelAccountResult) => void;
    readonly reject: (error: Error) => void;
    readonly onEvent?: (event: WhatsAppChannelAccountEvent) => Promise<void> | void;
    readonly timer: NodeJS.Timeout;
  }>();
  readonly #pendingCircuitResets = new Map<string, {
    readonly resolve: (result: CodexCircuitResetResult) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  readonly #pendingModels = new Map<string, {
    readonly resolve: (result: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  public constructor(
    profile: ProfileConfiguration,
    drainTimeoutMs: number,
    childExitTimeoutMs: number,
    codexRestartCooldownMs: number,
    diskSafetyFloorBytes: number
  ) {
    this.#profile = profile;
    this.#drainTimeoutMs = drainTimeoutMs;
    this.#childExitTimeoutMs = childExitTimeoutMs;
    this.#supervisorCodexRestartCooldownMs = codexRestartCooldownMs;
    this.#diskSafetyFloorBytes = diskSafetyFloorBytes;
    this.#health = { profileId: profile.id, readiness: "stopped", reason: null };
  }

  public health(): ProfileHealth {
    return { ...this.#health };
  }

  public subscribe(listener: (health: ProfileHealth) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async start(): Promise<ProfileHealth> {
    if (this.#child) return this.health();
    this.#expectedExit = false;
    this.#transition({ profileId: this.#profile.id, readiness: "starting", reason: null });
    const childEntry = fileURLToPath(
      new URL("../../profile-worker/dist/child-main.js", import.meta.url)
    );
    const child = fork(childEntry, [], {
      execArgv: [],
      serialization: "json",
      silent: true
    });
    this.#child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("message", (message: unknown) => {
      if (!isWorkerToSupervisorMessage(message)) return;
      if (message.type === "health") this.#transition(message.health);
      else if (message.type === "fatal") this.#transitionUnavailable("worker_start_failed");
      else this.#handleActionMessage(message);
    });
    child.once("error", () => this.#transitionUnavailable("worker_start_failed"));
    child.once("exit", () => {
      this.#child = undefined;
      this.#rejectPendingActions(new ProfileRuntimeActionError("profile_unavailable", "Profile worker exited"));
      if (!this.#expectedExit) this.#transitionUnavailable("worker_process_exit");
    });
    await onceSpawned(child);
    await send(child, {
      type: "start",
      config: {
        profileId: this.#profile.id,
        workspace: this.#profile.workspace,
        codexHome: this.#profile.codexHome,
        stateDirectory: this.#profile.stateDirectory,
        secretsFile: this.#profile.secretsFile,
        channelAccounts: this.#profile.channelAccounts,
        admission: this.#profile.admission,
        approval: this.#profile.approval,
        media: this.#profile.media,
        drainTimeoutMs: this.#drainTimeoutMs,
        childExitTimeoutMs: this.#childExitTimeoutMs,
        codexRestartCooldownMs: this.#supervisorCodexRestartCooldownMs,
        diskSafetyFloorBytes: this.#diskSafetyFloorBytes,
        ...(this.#profile.codexExecutable
          ? { codexExecutable: this.#profile.codexExecutable }
          : {})
      }
    });
    try {
      return await waitForHealth(
        this,
        (health) => ["ready", "degraded", "unavailable"].includes(health.readiness),
        60_000
      );
    } catch {
      this.#expectedExit = true;
      const exited = onceExit(child);
      child.kill("SIGTERM");
      await withTimeout(exited, this.#childExitTimeoutMs).catch(() => child.kill("SIGKILL"));
      this.#child = undefined;
      return this.#transition({
        profileId: this.#profile.id,
        readiness: "unavailable",
        reason: "worker_start_failed"
      });
    }
  }

  public async stop(): Promise<ProfileHealth> {
    const child = this.#child;
    if (!child) {
      return this.#transition({ ...this.#health, readiness: "stopped", reason: null });
    }
    this.#expectedExit = true;
    const exited = onceExit(child);
    await send(child, { type: "stop" }).catch(() => undefined);
    try {
      await withTimeout(exited, this.#drainTimeoutMs + this.#childExitTimeoutMs + 1_000);
    } catch {
      child.kill("SIGTERM");
      try {
        await withTimeout(exited, this.#childExitTimeoutMs);
      } catch {
        child.kill("SIGKILL");
        await withTimeout(exited, this.#childExitTimeoutMs).catch(() => undefined);
      }
      this.#child = undefined;
      return this.#transition({
        ...this.#health,
        readiness: "stopped",
        reason: "worker_stop_timeout"
      });
    }
    this.#child = undefined;
    return this.#transition({ ...this.#health, readiness: "stopped", reason: null });
  }

  public async executeWhatsAppAccountAction(
    channelAccountId: string,
    action: WhatsAppChannelAccountAction,
    onEvent?: (event: WhatsAppChannelAccountEvent) => Promise<void> | void
  ): Promise<WhatsAppChannelAccountResult> {
    const child = this.#child;
    if (!child || this.#expectedExit) {
      throw new ProfileRuntimeActionError("profile_unavailable", "Profile worker is unavailable");
    }
    const requestId = randomUUID();
    const timeoutMs = action.kind === "pair" ? (action.timeoutMs ?? 120_000) + 10_000 : 30_000;
    return new Promise<WhatsAppChannelAccountResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingActions.delete(requestId);
        reject(new ProfileRuntimeActionError("action_timeout", "WhatsApp action timed out"));
      }, timeoutMs);
      timer.unref();
      this.#pendingActions.set(requestId, {
        resolve,
        reject,
        ...(onEvent ? { onEvent } : {}),
        timer
      });
      void send(child, { type: "whatsapp_action", requestId, channelAccountId, action }).catch((error) => {
        const pending = this.#pendingActions.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pendingActions.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  public async executeModelAction(action: ModelAction): Promise<Record<string, unknown>> {
    const child = this.#child;
    if (!child || this.#expectedExit) throw new ProfileRuntimeActionError("profile_unavailable", "Profile worker is unavailable");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingModels.delete(requestId);
        reject(new ProfileRuntimeActionError("action_timeout", "Model action timed out; read settings before retrying a write"));
      }, 30_000);
      timer.unref();
      this.#pendingModels.set(requestId, { resolve, reject, timer });
      void send(child, { type: "model_action", requestId, action }).catch(() => {
        clearTimeout(timer);
        this.#pendingModels.delete(requestId);
        reject(new ProfileRuntimeActionError("profile_unavailable", "Profile worker is unavailable"));
      });
    });
  }

  public async resetCodexCircuit(): Promise<CodexCircuitResetResult> {
    const child = this.#child;
    if (!child || this.#expectedExit) {
      throw new ProfileRuntimeActionError("profile_unavailable", "Profile worker is unavailable");
    }
    const requestId = randomUUID();
    return new Promise<CodexCircuitResetResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCircuitResets.delete(requestId);
        reject(new ProfileRuntimeActionError("action_timeout", "Codex circuit reset timed out"));
      }, 30_000);
      timer.unref();
      this.#pendingCircuitResets.set(requestId, { resolve, reject, timer });
      void send(child, { type: "codex_circuit_reset", requestId }).catch((error) => {
        const pending = this.#pendingCircuitResets.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pendingCircuitResets.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  #handleActionMessage(
    message: Exclude<WorkerToSupervisorMessage, { readonly type: "health" | "fatal" }>
  ): void {
    if (message.type === "model_action_result" || message.type === "model_action_error") {
      const pending = this.#pendingModels.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pendingModels.delete(message.requestId);
      if (message.type === "model_action_result") pending.resolve(message.result);
      else pending.reject(new ProfileRuntimeActionError(message.error.code, message.error.message));
      return;
    }
    if (
      message.type === "codex_circuit_reset_result" ||
      message.type === "codex_circuit_reset_error"
    ) {
      const pending = this.#pendingCircuitResets.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pendingCircuitResets.delete(message.requestId);
      if (message.type === "codex_circuit_reset_result") pending.resolve(message.result);
      else pending.reject(new ProfileRuntimeActionError(message.error.code, message.error.message));
      return;
    }
    const pending = this.#pendingActions.get(message.requestId);
    if (!pending) return;
    if (message.type === "whatsapp_action_event") {
      Promise.resolve(pending.onEvent?.(message.event)).catch(() => undefined);
      return;
    }
    clearTimeout(pending.timer);
    this.#pendingActions.delete(message.requestId);
    if (message.type === "whatsapp_action_result") pending.resolve(message.result);
    else pending.reject(new ProfileRuntimeActionError(message.error.code, message.error.message));
  }

  #rejectPendingActions(error: Error): void {
    for (const pending of this.#pendingModels.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pendingModels.clear();
    for (const pending of this.#pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingActions.clear();
    for (const pending of this.#pendingCircuitResets.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingCircuitResets.clear();
  }

  #transitionUnavailable(reason: "worker_process_exit" | "worker_start_failed"): void {
    this.#transition({ profileId: this.#profile.id, readiness: "unavailable", reason });
  }

  #transition(health: ProfileHealth): ProfileHealth {
    if (sameHealth(this.#health, health)) return this.health();
    this.#health = { ...health };
    for (const listener of this.#listeners) listener(this.health());
    return this.health();
  }
}

function sameHealth(left: ProfileHealth, right: ProfileHealth): boolean {
  return (
    left.profileId === right.profileId &&
    left.readiness === right.readiness &&
    left.reason === right.reason &&
    left.codexVersion === right.codexVersion &&
    left.codexVerification === right.codexVerification &&
    JSON.stringify(left.channelAccounts) === JSON.stringify(right.channelAccounts)
  );
}

async function send(child: ChildProcess, message: SupervisorToWorkerMessage): Promise<void> {
  if (!child.connected || !child.send) throw new Error("Profile worker IPC is unavailable");
  await new Promise<void>((resolve, reject) => {
    child.send!(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function onceSpawned(child: ChildProcess): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function waitForHealth(
  runtime: ProfileRuntime,
  predicate: (health: ProfileHealth) => boolean,
  timeoutMs: number
): Promise<ProfileHealth> {
  const current = runtime.health();
  if (predicate(current)) return current;
  return new Promise<ProfileHealth>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Profile worker startup timed out"));
    }, timeoutMs);
    timer.unref();
    const unsubscribe = runtime.subscribe((health) => {
      if (!predicate(health)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(health);
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Profile worker exit timed out")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
