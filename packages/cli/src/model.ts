import { createHash } from "node:crypto";
import { ControlPlaneClient } from "@codex-channel-bridge/control-plane";
import { isModelAction, type ModelAction } from "@codex-channel-bridge/supervisor";
import { confirmPlan, parseOptions, printJson, rejectUnknownOptions, required } from "./terminal.js";

export async function runModelCommand(area: string | undefined, action: string | undefined, args: readonly string[]): Promise<boolean> {
  if (area !== "model") return false;
  if (!["list", "get", "set"].includes(action ?? "")) throw new Error("Use bridge model list, get, or set; see --help");
  const options = parseOptions(args);
  rejectUnknownOptions(options, ["endpoint", "profile", ...(action === "list" ? [] : ["scope", "thread"]), ...(action === "set" ? ["model", "effort", "confirm"] : [])]);
  const profileId = required(options, "profile");
  const operation = { kind: action, ...(options.scope ? { scope: options.scope } : {}),
    ...(options.thread ? { threadId: options.thread } : {}), ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}) };
  if (!isModelAction(operation)) throw new Error("Specify --scope thread --thread ID or --scope defaults; set also requires --model and/or --effort");
  const client = new ControlPlaneClient(options.endpoint);
  if (operation.kind === "set") {
    const query: ModelAction = { kind: "get", scope: operation.scope!, ...(operation.threadId ? { threadId: operation.threadId } : {}) };
    const current = await client.request("model/execute", { profileId, action: query });
    const digest = createHash("sha256").update(JSON.stringify([profileId, operation])).digest("hex");
    if (!options.confirm) printJson({ profileId, current, requested: operation, confirmationRequired: digest });
    if (!await confirmPlan("Apply native model settings?", digest, options.confirm)) return true;
  }
  const result = await client.request("model/execute", { profileId, action: operation });
  printJson({ profileId, ...result });
  if (operation.kind === "set" && result.verified !== true) process.exitCode = 2;
  return true;
}
