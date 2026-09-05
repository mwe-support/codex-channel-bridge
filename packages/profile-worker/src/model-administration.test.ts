import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ManagedCodexRpcRuntime } from "@codex-channel-bridge/codex-app-server";
import { administerModel, isModelAction } from "./model-administration.js";
import { TurnCoordinator } from "./turn-coordinator.js";
import { CodexEventRouter } from "./codex-event-router.js";

test("native model administration respects scope, discovery, capability, version and output boundaries", async () => {
  const calls: { method: string; params: any }[] = [];
  let model = "native-a";
  let effort = "medium";
  let cwd = "/workspace";
  const runtime = Object.assign(new EventEmitter(), {
    async request<T>(method: string, params: any): Promise<T> {
      calls.push({ method, params });
      if (method === "model/list") return { data: [{ id: "native-a", model: "native-a", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }] } as T;
      if (method === "thread/read") return { thread: { id: params.threadId, cwd, model, reasoningEffort: effort, preview: "private content" } } as T;
      if (method === "thread/resume") return { thread: { id: params.threadId } } as T;
      if (method === "thread/settings/update") { effort = params.effort ?? effort; return {} as T; }
      if (method === "config/read") return { config: { model, model_reasoning_effort: effort, secret: "private content" }, layers: [{ name: { type: "user", file: "/private/config.toml" }, version: "native-version" }] } as T;
      if (method === "config/batchWrite") { effort = params.edits.find((edit: any) => edit.keyPath === "model_reasoning_effort")?.value ?? effort; return { status: "ok", filePath: "/private/config.toml" } as T; }
      throw new Error(method);
    }
  }) as unknown as ManagedCodexRpcRuntime;
  const coordinator = new TurnCoordinator({ runtime, workspace: "/workspace", eventRouter: new CodexEventRouter() });
  const methods = ["thread/settings/update", "config/read", "config/batchWrite"];
  const act = (action: Parameters<typeof administerModel>[4], capabilities = methods) => administerModel(runtime, coordinator, capabilities, "/workspace", action);
  assert.equal(isModelAction({ kind: "get", scope: "defaults", threadId: "other" }), false);
  assert.equal(isModelAction({ kind: "list", model: "invented" }), false);
  assert.deepEqual(await act({ kind: "get", scope: "thread", threadId: "one" }), { scope: "thread", threadId: "one", model, effort });
  assert.equal(calls.some(call => call.method === "thread/resume"), false);
  cwd = "/other";
  await assert.rejects(act({ kind: "set", scope: "thread", threadId: "one", effort: "high" }), /outside/);
  assert.equal(calls.some(call => call.method === "thread/settings/update"), false);
  cwd = "/workspace";
  await assert.rejects(act({ kind: "set", scope: "thread", threadId: "one", effort: "high" }, []), /Unsupported/);
  await assert.rejects(act({ kind: "set", scope: "defaults", model: "invented" }), /absent/);
  await assert.rejects(act({ kind: "set", scope: "defaults", effort: "invented" }), /unsupported/);
  const updated = await act({ kind: "set", scope: "thread", threadId: "one", effort: "high" });
  assert.equal(updated.verified, true);
  const defaults = await act({ kind: "set", scope: "defaults", effort: "medium" });
  assert.equal(defaults.verified, true);
  const write = calls.find(call => call.method === "config/batchWrite")!.params;
  assert.deepEqual(write, { edits: [{ keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "replace" }], expectedVersion: "native-version", reloadUserConfig: false });
  assert.doesNotMatch(JSON.stringify(defaults), /private|config.toml|secret/);
});
