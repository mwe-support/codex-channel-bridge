import { chmod, link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { formatConfiguration, parseConfiguration } from "@codex-channel-bridge/config";

type SetupMode = "quick" | "full";
type AccessMode = "deny" | "allowlist" | "open";
interface Prompt {
  question(query: string): Promise<string>;
}

export interface SetupOptions {
  readonly mode: SetupMode;
  readonly configPath?: string;
}

export async function runInteractiveSetup(options: SetupOptions): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Setup requires an interactive terminal");
  const configPath = normalize(expandHome(options.configPath ?? defaultConfigPath()));
  if (!isAbsolute(configPath)) throw new Error("--config must be an absolute path");
  if (await lstat(configPath).catch(() => null)) throw new Error(`Configuration already exists: ${configPath}`);

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`Codex Channel Bridge ${options.mode} setup\n\n`);
    const raw = await collectConfiguration(prompt, options.mode);
    const text = formatConfiguration(raw);
    const configuration = parseConfiguration(text).configuration;
    const profile = Object.values(configuration.profiles)[0]!;
    await requireDirectory(profile.workspace, "Workspace");
    await requireDirectory(profile.codexHome, "Codex home");

    stdout.write(`\nConfiguration preview (${configPath}):\n\n${text}\n`);
    const confirmed = await choice(prompt, "Write this configuration?", ["yes", "no"], "no");
    if (confirmed !== "yes") {
      stdout.write("Setup cancelled; no files were changed.\n");
      return;
    }

    await createOwnerOnlyDirectory(profile.stateDirectory);
    await createOwnerOnlyDirectory(dirname(configPath));
    await writeNewFile(configPath, text);
    stdout.write(`Configuration written: ${configPath}\n`);
    stdout.write(`Validate it with: bridge config check --config ${configPath}\n`);
    if (Object.values(profile.channelAccounts).some((account) => account.provider === "whatsapp")) {
      stdout.write("After starting the Supervisor, pair WhatsApp with: bridge whatsapp pair --profile " +
        `${profile.id} --account ${Object.values(profile.channelAccounts).find((account) => account.provider === "whatsapp")!.id}\n`);
    }
  } finally {
    prompt.close();
  }
}

export async function collectConfiguration(prompt: Prompt, mode: SetupMode): Promise<unknown> {
  const profileId = await ask(prompt, "Profile ID", "primary");
  const workspace = await pathAnswer(prompt, "Workspace", process.cwd());
  const codexHome = await pathAnswer(prompt, "Codex home", process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const stateDirectory = mode === "full"
    ? await pathAnswer(prompt, "Profile state directory", defaultStateDirectory(profileId))
    : defaultStateDirectory(profileId);
  const providers = await choice(prompt, "Channels", ["qq", "whatsapp", "both"], "qq");
  const channelAccounts: Record<string, unknown> = {};

  if (providers === "qq" || providers === "both") {
    const id = await ask(prompt, "QQ Channel Account ID", "qq-primary");
    channelAccounts[id] = await collectAccount(prompt, mode, "qq");
  }
  if (providers === "whatsapp" || providers === "both") {
    const id = await ask(prompt, "WhatsApp Channel Account ID", "wa-primary");
    channelAccounts[id] = await collectAccount(prompt, mode, "whatsapp");
  }

  const profile: Record<string, unknown> = {
    workspace,
    codexHome,
    stateDirectory,
    channelAccounts
  };
  if (mode === "full") {
    const secretsFile = await pathAnswer(prompt, "Profile secrets file", join(stateDirectory, "secrets.env"));
    const codexExecutable = await optionalPathAnswer(prompt, "Codex executable (blank uses PATH)");
    profile.secretsFile = secretsFile;
    if (codexExecutable) profile.codexExecutable = codexExecutable;
    profile.admission = {
      mode: await choice(prompt, "Busy-message behavior", ["steer", "queue"], "steer"),
      maximumActiveTurns: await integer(prompt, "Maximum active Turns", 1),
      queueCapacity: await integer(prompt, "Queue capacity", 16),
      maximumQueueAgeMs: await integer(prompt, "Maximum queue age in milliseconds", 300_000),
      accountRateLimit: await integer(prompt, "Per-account message limit", 30),
      accountRateWindowMs: await integer(prompt, "Rate window in milliseconds", 60_000)
    };
    profile.approval = {
      timeoutMs: await integer(prompt, "Approval timeout in milliseconds", 300_000),
      detail: await choice(prompt, "Approval detail", ["minimal", "summary", "detailed"], "minimal")
    };
    profile.media = {
      perAttachmentLimitBytes: await integer(prompt, "Per-attachment byte limit", 64 * 1024 * 1024),
      profileQuotaBytes: await integer(prompt, "Profile media byte quota", 10 * 1024 * 1024 * 1024)
    };
  }

  return {
    schemaVersion: 1,
    ...(mode === "full" ? {
      supervisor: {
        drainTimeoutMs: await integer(prompt, "Drain timeout in milliseconds", 300_000),
        childExitTimeoutMs: await integer(prompt, "Child exit timeout in milliseconds", 10_000),
        codexRestartCooldownMs: await integer(prompt, "Codex restart cooldown in milliseconds", 30_000),
        diskSafetyFloorBytes: await integer(prompt, "Disk safety floor in bytes", 512 * 1024 * 1024)
      }
    } : {}),
    profiles: { [profileId]: profile }
  };
}

async function collectAccount(
  prompt: Prompt,
  mode: SetupMode,
  provider: "qq" | "whatsapp"
): Promise<Record<string, unknown>> {
  const account: Record<string, unknown> = {
    provider,
    epochId: "initial",
    groupThreadScope: mode === "full"
      ? await choice(prompt, `${provider} group Thread scope`, ["conversation", "participant"], "conversation")
      : "conversation"
  };
  if (provider === "qq") {
    account.appId = mode === "full"
      ? await ask(prompt, "QQ App ID Secret Reference", "env:QQ_BOT_APP_ID")
      : "env:QQ_BOT_APP_ID";
    account.appSecret = mode === "full"
      ? await ask(prompt, "QQ App Secret Reference", "env:QQ_BOT_APP_SECRET")
      : "env:QQ_BOT_APP_SECRET";
  }

  const privateChats = await accessRule(prompt, `${provider} private chats`);
  const groupChats = mode === "full" ? await accessRule(prompt, `${provider} group chats`) : { mode: "deny" };
  const groupParticipants = mode === "full"
    ? await accessRule(prompt, `${provider} group participants`)
    : { mode: "deny" };
  account.accessPolicy = { privateChats, groupChats, groupParticipants };
  return account;
}

async function accessRule(prompt: Prompt, label: string): Promise<Record<string, unknown>> {
  const mode = await choice(prompt, `${label} access`, ["deny", "allowlist", "open"], "deny") as AccessMode;
  if (mode !== "allowlist") return { mode };
  while (true) {
    const allow = (await ask(prompt, `${label} provider IDs (comma-separated)`, ""))
      .split(",").map((value) => value.trim()).filter(Boolean);
    if (allow.length > 0) return { mode, allow };
    stdout.write("At least one provider ID is required for allowlist mode.\n");
  }
}

async function ask(prompt: Prompt, label: string, fallback: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const value = (await prompt.question(`${label}${suffix}: `)).trim();
  return value || fallback;
}

async function choice(
  prompt: Prompt,
  label: string,
  values: readonly string[],
  fallback: string
): Promise<string> {
  while (true) {
    const value = (await ask(prompt, `${label} (${values.join("/")})`, fallback)).toLowerCase();
    if (values.includes(value)) return value;
    stdout.write(`Choose one of: ${values.join(", ")}\n`);
  }
}

async function integer(prompt: Prompt, label: string, fallback: number): Promise<number> {
  while (true) {
    const value = Number(await ask(prompt, label, String(fallback)));
    if (Number.isSafeInteger(value) && value >= 0) return value;
    stdout.write("Enter a non-negative integer.\n");
  }
}

async function pathAnswer(prompt: Prompt, label: string, fallback: string): Promise<string> {
  while (true) {
    const value = normalize(expandHome(await ask(prompt, label, fallback)));
    if (isAbsolute(value)) return value;
    stdout.write("Enter an absolute path.\n");
  }
}

async function optionalPathAnswer(prompt: Prompt, label: string): Promise<string | undefined> {
  while (true) {
    const answer = (await prompt.question(`${label}: `)).trim();
    if (!answer) return undefined;
    const value = normalize(expandHome(answer));
    if (isAbsolute(value)) return value;
    stdout.write("Enter an absolute path or leave it blank.\n");
  }
}

async function requireDirectory(path: string, label: string): Promise<void> {
  if (!(await stat(path).catch(() => null))?.isDirectory()) throw new Error(`${label} does not exist: ${path}`);
}

async function createOwnerOnlyDirectory(path: string): Promise<void> {
  const before = await lstat(path).catch(() => null);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!before && process.platform !== "win32") await chmod(path, 0o700);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Unsafe directory: ${path}`);
  if (process.platform !== "win32" &&
      (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700)) {
    throw new Error(`Directory must be owned by the current user with mode 0700: ${path}`);
  }
}

async function writeNewFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await unlink(temporary);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\")
    ? join(homedir(), path.slice(2))
    : path;
}

function defaultConfigPath(): string {
  const root = process.platform === "win32"
    ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(root, "codex-channel-bridge", "config.yaml");
}

function defaultStateDirectory(profileId: string): string {
  const root = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(root, "codex-channel-bridge", "profiles", profileId, "state");
}
