import type { ManagedCodexRpcRuntime } from "@codex-channel-bridge/codex-app-server";
import type { TurnCoordinator } from "./turn-coordinator.js";

export interface ModelAction {
  readonly kind: "list" | "get" | "set";
  readonly scope?: "thread" | "defaults";
  readonly threadId?: string;
  readonly model?: string;
  readonly effort?: string;
}

export function isModelAction(value: unknown): value is ModelAction {
  if (!record(value) || Object.keys(value).some(key => !["kind", "scope", "threadId", "model", "effort"].includes(key))) return false;
  if (value.kind === "list") return Object.keys(value).length === 1;
  if (value.kind !== "get" && value.kind !== "set") return false;
  if (value.scope !== "defaults" && value.scope !== "thread") return false;
  if (value.scope === "thread" ? !text(value.threadId) : value.threadId !== undefined) return false;
  if (value.kind === "get") return value.model === undefined && value.effort === undefined;
  return (value.model === undefined || text(value.model)) && (value.effort === undefined || text(value.effort)) &&
    (value.model !== undefined || value.effort !== undefined);
}

/** Projects only model fields; native config and Thread payloads never leave the worker. */
export async function administerModel(
  runtime: ManagedCodexRpcRuntime,
  coordinator: TurnCoordinator,
  methods: readonly string[],
  workspace: string,
  action: ModelAction
): Promise<Record<string, unknown>> {
  if (!isModelAction(action)) throw new Error("Invalid model operation or scope");
  if (action.kind === "list") return { models: (await coordinator.listModels()).map(model => ({
    id: model.id, model: model.model, defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts
  })) };
  const read = async (): Promise<Record<string, unknown>> => {
    if (action.scope === "thread") {
      const result = await runtime.request<{ thread: { id: string; cwd: string; model?: string | null; reasoningEffort?: string | null } }>(
        "thread/read", { threadId: action.threadId, includeTurns: false });
      if (result.thread.id !== action.threadId || result.thread.cwd !== workspace) throw new Error("Thread is outside this Profile Workspace");
      return { scope: "thread", threadId: action.threadId, model: result.thread.model ?? null, effort: result.thread.reasoningEffort ?? null };
    }
    requireMethod(methods, "config/read");
    const result = await runtime.request<{ config: Record<string, unknown> }>("config/read", { cwd: workspace, includeLayers: false });
    return { scope: "defaults", model: result.config.model ?? null, effort: result.config.model_reasoning_effort ?? null };
  };
  const before = await read();
  if (action.kind === "get") return before;
  const model = (await coordinator.listModels()).find(entry => entry.model === (action.model ?? before.model));
  if (!model) throw new Error("Model is absent from native discovery; select an explicit available model");
  if (action.effort && !model.supportedReasoningEfforts.some(entry => entry.reasoningEffort === action.effort)) {
    throw new Error("Reasoning effort is unsupported by the selected native model");
  }
  const settings = { ...(action.model ? { model: action.model } : {}), ...(action.effort ? { effort: action.effort } : {}) };
  if (action.scope === "thread") {
    requireMethod(methods, "thread/settings/update");
    await coordinator.updateThreadSettings(action.threadId!, settings);
    // Native update acknowledges enqueueing. Readback may precede application; do not claim verification then.
    const observed = await read();
    return { ...observed, requested: settings, verified: matches(observed, settings), appliesTo: "subsequent turns" };
  }
  requireMethod(methods, "config/batchWrite");
  const config = await runtime.request<{ layers?: { name: { type: string }; version: string }[] }>("config/read", { cwd: workspace, includeLayers: true });
  const users = config.layers?.filter(layer => layer.name.type === "user") ?? [];
  if (users.length !== 1 || !text(users[0]?.version)) throw new Error("Native user configuration layer is ambiguous or unavailable");
  const edits = Object.entries(settings).map(([key, value]) => ({ keyPath: key === "effort" ? "model_reasoning_effort" : key, value, mergeStrategy: "replace" }));
  const result = await runtime.request<{ status: string }>("config/batchWrite", {
    edits, expectedVersion: users[0]!.version, reloadUserConfig: false
  });
  const observed = await read();
  return { ...observed, requested: settings, status: result.status, verified: matches(observed, settings),
    appliesTo: "native defaults for future Threads; existing Threads retain their settings" };
}
function requireMethod(methods: readonly string[], method: string): void {
  if (!methods.includes(method)) throw new Error(`Unsupported native capability: ${method}`);
}
function matches(value: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, item]) => value[key] === item);
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
