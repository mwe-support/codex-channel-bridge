import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConfigurationEdit, loadConfiguration, planConfigurationEdit,
  SecretResolver, writeProfileSecret
} from "@codex-channel-bridge/config";
import { ControlPlaneClient } from "@codex-channel-bridge/control-plane";
import { secureWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";
import { defaultConfigPath } from "./setup.js";
import { confirmPlan, parseOptions, printJson, readSecret, readStdin, rejectUnknownOptions, required } from "./terminal.js";

export async function runSettingsCommand(area: string | undefined, action: string | undefined, args: readonly string[]): Promise<boolean> {
  if ((area === "profile" || area === "channel") && (action === "set" || action === "enable" || action === "disable")) {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["config", "profile", "confirm", ...(area === "channel" ? ["account"] : []), ...(action === "set" ? ["key", "value-json"] : [])]);
    const profile = required(options, "profile");
    const account = area === "channel" ? required(options, "account") : undefined;
    if (![profile, ...(account ? [account] : [])].every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error("Invalid target identifier");
    const configuration = (await loadConfiguration(options.config ?? defaultConfigPath())).configuration;
    if (!configuration.profiles[profile] || (account && !configuration.profiles[profile]!.channelAccounts[account])) throw new Error("Target is not configured in the selected Profile");
    const key = `profiles.${profile}${account ? `.channelAccounts.${account}` : ""}.${action === "set" ? required(options, "key") : "enabled"}`;
    return runSettingsCommand("config", "set", ["--config", options.config ?? defaultConfigPath(), "--key", key,
      "--value-json", action === "set" ? required(options, "value-json") : String(action === "enable"),
      ...(options.confirm ? ["--confirm", options.confirm] : []), ...(options.json ? ["--json"] : [])]);
  }
  if (area === "config" && ["get", "set", "edit"].includes(action ?? "")) {
    const options = parseOptions(args);
    rejectUnknownOptions(options, action === "get" ? ["config", "key"] :
      action === "set" ? ["config", "key", "value-json", "confirm"] : ["config", "editor", "confirm"]);
    const configPath = options.config ?? defaultConfigPath();
    if (action === "get") {
      const candidate = await loadConfiguration(configPath);
      const value = options.key ? valueAt(candidate.configuration, options.key) : candidate.configuration;
      printJson({ revision: candidate.revision, environmentOverrideApplied: candidate.environmentOverrideApplied, value });
      return true;
    }
    let plan;
    if (action === "set") {
      let value: unknown;
      try { value = JSON.parse(required(options, "value-json")); }
      catch { throw new Error("--value-json must contain one valid JSON value"); }
      plan = await planConfigurationEdit(configPath, { key: required(options, "key"), value });
    } else {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("config edit requires an interactive terminal; use config set for scripts");
      const directory = await mkdtemp(join(tmpdir(), "bridge-config-edit-"));
      secureWindowsOwnerOnlyPath(directory, "directory");
      const temporary = join(directory, "config.yaml");
      try {
        const original = await readFile(configPath, "utf8");
        await writeFile(temporary, original, { mode: 0o600 });
        secureWindowsOwnerOnlyPath(temporary, "file");
        const editor = options.editor ?? process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad.exe" : "vi");
        await runEditor(editor, temporary);
        const text = await readFile(temporary, "utf8");
        // Planning must refer to the same disk revision the editor started from.
        if (await readFile(configPath, "utf8") !== original) throw new Error("Configuration changed while the editor was open; retry");
        plan = await planConfigurationEdit(configPath, { text });
        if (plan.sourceDigest !== createHash("sha256").update(original).digest("hex")) throw new Error("Configuration changed while preparing the editor result; retry");
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    if (!options.confirm) printJson({ saved: false, configPath, key: options.key ?? null, candidateRevision: plan.candidateRevision,
      environmentOverrideApplied: plan.environmentOverrideApplied, confirmationRequired: plan.planDigest,
      next: "Saving does not apply runtime changes; use bridge config apply afterwards" });
    if (await confirmPlan("Save validated configuration?", plan.planDigest, options.confirm)) {
      await applyConfigurationEdit(plan, plan.planDigest);
      printJson({ saved: true, applied: false, candidateRevision: plan.candidateRevision });
    }
    return true;
  }
  if (area === "secret" && action === "set") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["config", "profile", "name", "from-env", "from-file", "stdin"]);
    const profileId = required(options, "profile");
    const candidate = await loadConfiguration(options.config ?? defaultConfigPath());
    const profile = candidate.configuration.profiles[profileId];
    if (!profile) throw new Error("Profile is not configured");
    const sources = ["from-env", "from-file", "stdin"].filter((key) => options[key] !== undefined);
    if (sources.length > 1) throw new Error("Choose only one secret input source");
    let value: string;
    if (options["from-env"] !== undefined) {
      value = process.env[options["from-env"]] ?? "";
    } else if (options["from-file"] !== undefined) {
      value = await (await SecretResolver.open()).resolve(`file:${options["from-file"]}`);
    } else if (options.stdin !== undefined) value = (await readStdin()).replace(/\r?\n$/u, "");
    else value = await readSecret();
    await writeProfileSecret(profile.secretsFile, required(options, "name"), value);
    printJson({ saved: true, profileId, next: "Apply configuration or restart the Profile to reload persistent secrets; process environment takes precedence" });
    return true;
  }
  if ((area === "profile" || area === "channel") && (action === "list" || action === "status")) {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", ...(area === "channel" ? ["account"] : []), ...(action === "list" ? ["config"] : ["endpoint"])]);
    if (options.account && !options.profile) throw new Error("--account requires --profile");
    if (action === "list") {
      const candidate = await loadConfiguration(options.config ?? defaultConfigPath());
      const profiles = Object.values(candidate.configuration.profiles).filter((profile) => !options.profile || profile.id === options.profile);
      if (options.profile && profiles.length === 0) throw new Error("Profile is not configured");
      if (area === "profile") printJson(profiles.map(({ id, enabled, workspace, codexHome, stateDirectory }) => ({ profileId: id, enabled, workspace, codexHome, stateDirectory })));
      else {
        const accounts = profiles.flatMap((profile) => Object.values(profile.channelAccounts)
          .filter((account) => !options.account || account.id === options.account)
          .map(({ id, provider, enabled, groupThreadScope }) => ({ profileId: profile.id, channelAccountId: id, provider, enabled, groupThreadScope })));
        if (options.account && accounts.length === 0) throw new Error("Channel Account is not configured in the selected Profile");
        printJson(accounts);
      }
      return true;
    }
    const status = await new ControlPlaneClient(options.endpoint).request("status/get");
    const profiles = options.profile ? status.profiles.filter((profile) => profile.profileId === options.profile) : status.profiles;
    if (options.profile && profiles.length === 0) throw new Error("Profile is not configured");
    if (area === "profile") printJson(profiles);
    else {
      const accounts = profiles.flatMap((profile) => (profile.channelAccounts ?? [])
        .filter((account) => !options.account || account.channelAccountId === options.account)
        .map((account) => ({ profileId: profile.profileId, ...account })));
      if (options.account && accounts.length === 0) throw new Error("Channel Account has no observed runtime status; use channel list for configuration");
      printJson(accounts);
    }
    return true;
  }
  return false;
}

function valueAt(value: unknown, key: string): unknown {
  for (const part of key.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) throw new Error("Configuration key does not exist");
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

async function runEditor(executable: string, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [path], { stdio: "inherit", shell: false });
    child.once("error", () => reject(new Error("Editor could not be started; --editor must name one executable without shell arguments")));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Editor exited unsuccessfully; configuration was not saved")));
  });
}
