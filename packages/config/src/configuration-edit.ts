import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { loadConfiguration, parseConfiguration, validateProfileDirectories } from "./config.js";
import { readOwnerOnlyFile, updateOwnerOnlyFile } from "./atomic-file.js";

export interface ConfigurationEdit {
  readonly configPath: string;
  readonly sourceDigest: string;
  readonly candidateRevision: string;
  readonly text: string;
  readonly planDigest: string;
  readonly environmentOverrideApplied: boolean;
}

export async function planConfigurationEdit(
  configPath: string,
  edit: { readonly key: string; readonly value: unknown } | { readonly text: string }
): Promise<ConfigurationEdit> {
  // Load first for path, schema and directory checks; parse the disk document to preserve overrides and comments.
  await loadConfiguration(configPath);
  const before = await readOwnerOnlyFile(configPath);
  if (before === null) throw new Error("Configuration file does not exist");
  parseConfiguration(before);
  let text: string;
  if ("text" in edit) text = edit.text;
  else {
    const path = edit.key.split(".");
    if (path.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || ["__proto__", "constructor", "prototype"].includes(part))) {
      throw new Error("--key must be a dotted configuration path without reserved object keys");
    }
    const document = parseDocument(before);
    document.setIn(path, edit.value);
    text = document.toString({ lineWidth: 0 });
  }
  parseConfiguration(text);
  const candidate = parseConfiguration(text, process.env.BRIDGE_CONFIG_OVERRIDES_JSON);
  await validateProfileDirectories(candidate.configuration);
  const sourceDigest = digest(before);
  return {
    configPath,
    sourceDigest,
    text,
    candidateRevision: candidate.revision,
    environmentOverrideApplied: candidate.environmentOverrideApplied,
    planDigest: digest(JSON.stringify([configPath, sourceDigest, text, candidate.revision]))
  };
}

export async function applyConfigurationEdit(plan: ConfigurationEdit, confirmation: string): Promise<void> {
  if (confirmation !== plan.planDigest) throw new Error("Confirmation must match the full configuration edit digest");
  await updateOwnerOnlyFile(plan.configPath, async (previous) => {
    if (previous === null || digest(previous) !== plan.sourceDigest) throw new Error("Configuration changed; prepare a new edit");
    const current = parseConfiguration(plan.text, process.env.BRIDGE_CONFIG_OVERRIDES_JSON);
    if (current.revision !== plan.candidateRevision) throw new Error("Environment overrides changed; prepare a new edit");
    await validateProfileDirectories(current.configuration);
    return plan.text;
  });
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
