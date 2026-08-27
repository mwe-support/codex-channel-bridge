import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ProfileConfiguration, SupervisorConfiguration } from "@codex-channel-bridge/config";
import type { ProfileHealth } from "@codex-channel-bridge/core";
import {
  isWorkerToSupervisorMessage,
  type SupervisorToWorkerMessage
} from "@codex-channel-bridge/profile-worker";

export interface ProfileRuntime {
  start(): Promise<ProfileHealth>;
  stop(): Promise<ProfileHealth>;
  health(): ProfileHealth;
  subscribe(listener: (health: ProfileHealth) => void): () => void;
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
      supervisor.childExitTimeoutMs
    );
  }
}

class ForkedProfileRuntime implements ProfileRuntime {
  readonly #profile: ProfileConfiguration;
  readonly #drainTimeoutMs: number;
  readonly #childExitTimeoutMs: number;
  readonly #listeners = new Set<(health: ProfileHealth) => void>();
  #child?: ChildProcess;
  #health: ProfileHealth;
  #expectedExit = false;

  public constructor(
    profile: ProfileConfiguration,
    drainTimeoutMs: number,
    childExitTimeoutMs: number
  ) {
    this.#profile = profile;
    this.#drainTimeoutMs = drainTimeoutMs;
    this.#childExitTimeoutMs = childExitTimeoutMs;
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
      else this.#transitionUnavailable("worker_start_failed");
    });
    child.once("error", () => this.#transitionUnavailable("worker_start_failed"));
    child.once("exit", () => {
      this.#child = undefined;
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
      await withTimeout(exited, this.#drainTimeoutMs);
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
    left.codexVerification === right.codexVerification
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
