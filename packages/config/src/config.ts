import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import { parseDocument } from "yaml";

const MAX_CONFIG_BYTES = 1024 * 1024;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const CHANNEL_ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const CHANNEL_ACCOUNT_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "supervisor", "profiles"]);
const SUPERVISOR_KEYS = new Set([
  "drainTimeoutMs",
  "childExitTimeoutMs",
  "codexRestartCooldownMs",
  "diskSafetyFloorBytes"
]);
const PROFILE_KEYS = new Set([
  "enabled",
  "workspace",
  "codexHome",
  "stateDirectory",
  "secretsFile",
  "channelAccounts",
  "codexExecutable",
  "admission",
  "approval",
  "media"
]);
const QQ_CHANNEL_ACCOUNT_KEYS = new Set([
  "provider",
  "enabled",
  "epochId",
  "appId",
  "appSecret",
  "accessPolicy",
  "groupThreadScope"
]);
const WHATSAPP_CHANNEL_ACCOUNT_KEYS = new Set([
  "provider",
  "enabled",
  "epochId",
  "accessPolicy",
  "groupThreadScope"
]);
const ADMISSION_KEYS = new Set([
  "mode",
  "maximumActiveTurns",
  "queueCapacity",
  "maximumQueueAgeMs",
  "accountRateLimit",
  "accountRateWindowMs"
]);
const APPROVAL_KEYS = new Set(["timeoutMs", "detail"]);
const MEDIA_KEYS = new Set(["perAttachmentLimitBytes", "profileQuotaBytes"]);
const ACCESS_POLICY_KEYS = new Set(["privateChats", "groupChats", "groupParticipants"]);
const ACCESS_RULE_KEYS = new Set(["mode", "allow"]);

export interface AccessRuleConfiguration {
  readonly mode: "deny" | "allowlist" | "open";
  readonly allow: readonly string[];
}

export interface ChannelAccessPolicyConfiguration {
  readonly privateChats: AccessRuleConfiguration;
  readonly groupChats: AccessRuleConfiguration;
  readonly groupParticipants: AccessRuleConfiguration;
}

export interface AdmissionConfiguration {
  readonly mode: "steer" | "queue";
  readonly maximumActiveTurns: number;
  readonly queueCapacity: number;
  readonly maximumQueueAgeMs: number;
  readonly accountRateLimit: number;
  readonly accountRateWindowMs: number;
}

export interface ApprovalConfiguration {
  readonly timeoutMs: number;
  readonly detail: "minimal" | "summary" | "detailed";
}

export interface MediaConfiguration {
  readonly perAttachmentLimitBytes: number;
  readonly profileQuotaBytes: number;
}

export interface QQChannelAccountConfiguration {
  readonly id: string;
  readonly provider: "qq";
  readonly enabled: boolean;
  readonly epochId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly groupThreadScope: "conversation" | "participant";
  readonly accessPolicy: ChannelAccessPolicyConfiguration;
}

export interface WhatsAppChannelAccountConfiguration {
  readonly id: string;
  readonly provider: "whatsapp";
  readonly enabled: boolean;
  readonly epochId: string;
  readonly groupThreadScope: "conversation" | "participant";
  readonly accessPolicy: ChannelAccessPolicyConfiguration;
}

export type ChannelAccountConfiguration =
  | QQChannelAccountConfiguration
  | WhatsAppChannelAccountConfiguration;

export interface ProfileConfiguration {
  readonly id: string;
  readonly enabled: boolean;
  readonly workspace: string;
  readonly codexHome: string;
  readonly stateDirectory: string;
  readonly secretsFile: string;
  readonly channelAccounts: Readonly<Record<string, ChannelAccountConfiguration>>;
  readonly codexExecutable?: string;
  readonly admission: AdmissionConfiguration;
  readonly approval: ApprovalConfiguration;
  readonly media: MediaConfiguration;
}

export interface SupervisorConfiguration {
  readonly drainTimeoutMs: number;
  readonly childExitTimeoutMs: number;
  readonly codexRestartCooldownMs: number;
  readonly diskSafetyFloorBytes: number;
}

export interface BridgeConfiguration {
  readonly schemaVersion: 1;
  readonly supervisor: SupervisorConfiguration;
  readonly profiles: Readonly<Record<string, ProfileConfiguration>>;
}

export interface ConfigurationCandidate {
  readonly revision: string;
  readonly configuration: BridgeConfiguration;
  readonly environmentOverrideApplied: boolean;
}

export interface LoadConfigurationOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly overrideVariable?: string;
  readonly validateDirectories?: boolean;
}

export class ConfigurationValidationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`Configuration is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "ConfigurationValidationError";
  }
}

export async function loadConfiguration(
  absolutePath: string,
  options: LoadConfigurationOptions = {}
): Promise<ConfigurationCandidate> {
  if (!isAbsolute(absolutePath)) {
    throw new ConfigurationValidationError(["config path must be absolute"]);
  }
  const metadata = await lstat(absolutePath).catch(() => null);
  if (!metadata?.isFile()) {
    throw new ConfigurationValidationError(["config path must name a regular file"]);
  }
  if (metadata.size > MAX_CONFIG_BYTES) {
    throw new ConfigurationValidationError(["config file exceeds the 1 MiB limit"]);
  }
  const text = await readFile(absolutePath, "utf8");
  const overrideVariable = options.overrideVariable ?? "BRIDGE_CONFIG_OVERRIDES_JSON";
  const overrideText = (options.environment ?? process.env)[overrideVariable];
  const candidate = parseConfiguration(text, overrideText);
  if (options.validateDirectories !== false) {
    await validateProfileDirectories(candidate.configuration);
  }
  return candidate;
}

export function parseConfiguration(
  yamlText: string,
  environmentOverrideJson?: string
): ConfigurationCandidate {
  if (Buffer.byteLength(yamlText, "utf8") > MAX_CONFIG_BYTES) {
    throw new ConfigurationValidationError(["config content exceeds the 1 MiB limit"]);
  }

  const document = parseDocument(yamlText, {
    schema: "core",
    strict: true,
    uniqueKeys: true
  });
  const yamlIssues = [...document.errors, ...document.warnings].map(
    (_issue, index) => `YAML parse issue ${index + 1}`
  );
  if (yamlIssues.length > 0) throw new ConfigurationValidationError(yamlIssues);

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new ConfigurationValidationError(["YAML aliases are not allowed"]);
  }
  if (containsReservedObjectKey(raw)) {
    throw new ConfigurationValidationError(["config contains a reserved object key"]);
  }

  let overrideApplied = false;
  if (environmentOverrideJson !== undefined) {
    overrideApplied = true;
    let override: unknown;
    try {
      override = JSON.parse(environmentOverrideJson);
    } catch {
      throw new ConfigurationValidationError(["environment override is not valid JSON"]);
    }
    if (!isRecord(override)) {
      throw new ConfigurationValidationError(["environment override must be a JSON object"]);
    }
    if (containsReservedObjectKey(override)) {
      throw new ConfigurationValidationError(["environment override contains a reserved object key"]);
    }
    raw = deepMerge(raw, override);
  }

  const configuration = validateShape(raw);
  return {
    revision: createHash("sha256").update(canonicalJson(configuration)).digest("hex"),
    configuration,
    environmentOverrideApplied: overrideApplied
  };
}

async function validateProfileDirectories(configuration: BridgeConfiguration): Promise<void> {
  const issues: string[] = [];
  await Promise.all(
    Object.values(configuration.profiles).map(async (profile) => {
      const [workspace, codexHome, stateDirectory] = await Promise.all([
        stat(profile.workspace).catch(() => null),
        stat(profile.codexHome).catch(() => null),
        lstat(profile.stateDirectory).catch(() => null)
      ]);
      if (!workspace?.isDirectory()) issues.push(`profiles.${profile.id}.workspace must exist as a directory`);
      if (!codexHome?.isDirectory()) issues.push(`profiles.${profile.id}.codexHome must exist as a directory`);
      if (!stateDirectory?.isDirectory() || stateDirectory.isSymbolicLink()) {
        issues.push(`profiles.${profile.id}.stateDirectory must exist as a real directory`);
      } else if (
        process.platform !== "win32" &&
        (stateDirectory.uid !== process.getuid?.() || (stateDirectory.mode & 0o777) !== 0o700)
      ) {
        issues.push(`profiles.${profile.id}.stateDirectory must be owned by the service user with mode 0700`);
      }
    })
  );
  if (issues.length > 0) throw new ConfigurationValidationError(issues.sort());
}

function validateShape(raw: unknown): BridgeConfiguration {
  const issues: string[] = [];
  if (!isRecord(raw)) throw new ConfigurationValidationError(["config root must be a mapping"]);
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, "config", issues);
  if (raw.schemaVersion !== 1) issues.push("schemaVersion must equal 1");

  const supervisorRaw = raw.supervisor === undefined ? {} : raw.supervisor;
  if (!isRecord(supervisorRaw)) {
    issues.push("supervisor must be a mapping");
  } else {
    rejectUnknownKeys(supervisorRaw, SUPERVISOR_KEYS, "supervisor", issues);
  }
  const drainTimeoutMs = integerWithin(
    isRecord(supervisorRaw) ? supervisorRaw.drainTimeoutMs : undefined,
    300_000,
    1_000,
    3_600_000,
    "supervisor.drainTimeoutMs",
    issues
  );
  const childExitTimeoutMs = integerWithin(
    isRecord(supervisorRaw) ? supervisorRaw.childExitTimeoutMs : undefined,
    10_000,
    1_000,
    60_000,
    "supervisor.childExitTimeoutMs",
    issues
  );
  const codexRestartCooldownMs = integerWithin(
    isRecord(supervisorRaw) ? supervisorRaw.codexRestartCooldownMs : undefined,
    30_000,
    1_000,
    3_600_000,
    "supervisor.codexRestartCooldownMs",
    issues
  );
  const diskSafetyFloorBytes = integerWithin(
    isRecord(supervisorRaw) ? supervisorRaw.diskSafetyFloorBytes : undefined,
    512 * 1024 * 1024,
    16 * 1024 * 1024,
    1024 * 1024 * 1024 * 1024,
    "supervisor.diskSafetyFloorBytes",
    issues
  );

  const profiles: Record<string, ProfileConfiguration> = {};
  if (!isRecord(raw.profiles)) {
    issues.push("profiles must be a mapping keyed by Profile ID");
  } else {
    rejectDuplicateDeclaredChannelAccountIds(raw.profiles, issues);
    for (const [id, value] of Object.entries(raw.profiles)) {
      if (!PROFILE_ID_PATTERN.test(id)) {
        issues.push(`profiles.${id} is not a valid Profile ID`);
        continue;
      }
      if (!isRecord(value)) {
        issues.push(`profiles.${id} must be a mapping`);
        continue;
      }
      rejectUnknownKeys(value, PROFILE_KEYS, `profiles.${id}`, issues);
      const enabled = value.enabled === undefined ? true : value.enabled;
      if (typeof enabled !== "boolean") issues.push(`profiles.${id}.enabled must be boolean`);
      const workspace = absolutePath(value.workspace, `profiles.${id}.workspace`, issues);
      const codexHome = absolutePath(value.codexHome, `profiles.${id}.codexHome`, issues);
      const stateDirectory = absolutePath(
        value.stateDirectory,
        `profiles.${id}.stateDirectory`,
        issues
      );
      const secretsFile =
        value.secretsFile === undefined
          ? stateDirectory
            ? join(stateDirectory, "secrets.env")
            : null
          : absolutePath(value.secretsFile, `profiles.${id}.secretsFile`, issues);
      const channelAccounts = validateChannelAccounts(
        value.channelAccounts,
        `profiles.${id}.channelAccounts`,
        issues
      );
      const codexExecutable = optionalExecutablePath(
        value.codexExecutable,
        `profiles.${id}.codexExecutable`,
        issues
      );
      const admission = validateAdmission(value.admission, `profiles.${id}.admission`, issues);
      const approval = validateApproval(value.approval, `profiles.${id}.approval`, issues);
      const media = validateMedia(value.media, `profiles.${id}.media`, issues);
      if (
        workspace &&
        codexHome &&
        stateDirectory &&
        secretsFile &&
        channelAccounts &&
        typeof enabled === "boolean"
      ) {
        profiles[id] = {
          id,
          enabled,
          workspace,
          codexHome,
          stateDirectory,
          secretsFile,
          channelAccounts,
          admission,
          approval,
          media,
          ...(codexExecutable ? { codexExecutable } : {})
        };
      }
    }
  }

  rejectOverlappingOwnedPaths(profiles, issues);
  rejectOverlappingSecretFiles(profiles, issues);
  if (issues.length > 0) throw new ConfigurationValidationError(issues.sort());

  return {
    schemaVersion: 1,
    supervisor: {
      drainTimeoutMs,
      childExitTimeoutMs,
      codexRestartCooldownMs,
      diskSafetyFloorBytes
    },
    profiles: Object.fromEntries(Object.entries(profiles).sort(([left], [right]) => left.localeCompare(right)))
  };
}

function validateMedia(
  value: unknown,
  path: string,
  issues: string[]
): MediaConfiguration {
  const raw = value === undefined ? {} : value;
  if (!isRecord(raw)) {
    issues.push(`${path} must be a mapping`);
    return defaultMedia();
  }
  rejectUnknownKeys(raw, MEDIA_KEYS, path, issues);
  const perAttachmentLimitBytes = integerWithin(
    raw.perAttachmentLimitBytes,
    64 * 1024 * 1024,
    1,
    1024 * 1024 * 1024 * 1024,
    `${path}.perAttachmentLimitBytes`,
    issues
  );
  const profileQuotaBytes = integerWithin(
    raw.profileQuotaBytes,
    10 * 1024 * 1024 * 1024,
    1,
    Number.MAX_SAFE_INTEGER,
    `${path}.profileQuotaBytes`,
    issues
  );
  if (profileQuotaBytes < perAttachmentLimitBytes) {
    issues.push(`${path}.profileQuotaBytes must be at least perAttachmentLimitBytes`);
  }
  return { perAttachmentLimitBytes, profileQuotaBytes };
}

function defaultMedia(): MediaConfiguration {
  return {
    perAttachmentLimitBytes: 64 * 1024 * 1024,
    profileQuotaBytes: 10 * 1024 * 1024 * 1024
  };
}

function validateApproval(
  value: unknown,
  path: string,
  issues: string[]
): ApprovalConfiguration {
  const raw = value === undefined ? {} : value;
  if (!isRecord(raw)) {
    issues.push(`${path} must be a mapping`);
    return defaultApproval();
  }
  rejectUnknownKeys(raw, APPROVAL_KEYS, path, issues);
  const detail = raw.detail === undefined ? "minimal" : raw.detail;
  if (detail !== "minimal" && detail !== "summary" && detail !== "detailed") {
    issues.push(`${path}.detail must equal minimal, summary, or detailed`);
  }
  return {
    timeoutMs: integerWithin(raw.timeoutMs, 300_000, 10_000, 3_600_000, `${path}.timeoutMs`, issues),
    detail: detail === "summary" || detail === "detailed" ? detail : "minimal"
  };
}

function defaultApproval(): ApprovalConfiguration {
  return { timeoutMs: 300_000, detail: "minimal" };
}

function validateChannelAccounts(
  value: unknown,
  path: string,
  issues: string[]
): Record<string, ChannelAccountConfiguration> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.push(`${path} must be a mapping keyed by Channel Account ID`);
    return null;
  }
  const accounts: Record<string, ChannelAccountConfiguration> = {};
  for (const [id, account] of Object.entries(value)) {
    const accountPath = `${path}.${id}`;
    if (!CHANNEL_ACCOUNT_ID_PATTERN.test(id)) {
      issues.push(`${accountPath} is not a valid Channel Account ID`);
      continue;
    }
    if (!isRecord(account)) {
      issues.push(`${accountPath} must be a mapping`);
      continue;
    }
    if (account.provider !== "qq" && account.provider !== "whatsapp") {
      issues.push(`${accountPath}.provider must equal qq or whatsapp`);
      continue;
    }
    rejectUnknownKeys(
      account,
      account.provider === "qq" ? QQ_CHANNEL_ACCOUNT_KEYS : WHATSAPP_CHANNEL_ACCOUNT_KEYS,
      accountPath,
      issues
    );
    const enabled = account.enabled === undefined ? true : account.enabled;
    if (typeof enabled !== "boolean") issues.push(`${accountPath}.enabled must be boolean`);
    const epochId =
      typeof account.epochId === "string" && CHANNEL_ACCOUNT_EPOCH_PATTERN.test(account.epochId)
        ? account.epochId
        : null;
    if (!epochId) issues.push(`${accountPath}.epochId is invalid`);
    const appId = account.provider === "qq"
      ? secretReference(account.appId, `${accountPath}.appId`, issues)
      : null;
    const appSecret = account.provider === "qq"
      ? secretReference(account.appSecret, `${accountPath}.appSecret`, issues)
      : null;
    const groupThreadScope =
      account.groupThreadScope === undefined ? "conversation" : account.groupThreadScope;
    if (groupThreadScope !== "conversation" && groupThreadScope !== "participant") {
      issues.push(`${accountPath}.groupThreadScope must equal conversation or participant`);
    }
    const accessPolicy = validateAccessPolicy(
      account.accessPolicy,
      `${accountPath}.accessPolicy`,
      issues
    );
    if (typeof enabled === "boolean" && epochId) {
      const common = {
        id,
        enabled,
        epochId,
        groupThreadScope:
          groupThreadScope === "participant" ? "participant" as const : "conversation" as const,
        accessPolicy
      };
      if (account.provider === "whatsapp") {
        accounts[id] = { ...common, provider: "whatsapp" };
      } else if (appId && appSecret) {
        accounts[id] = { ...common, provider: "qq", appId, appSecret };
      }
    }
  }
  return Object.fromEntries(Object.entries(accounts).sort(([left], [right]) => left.localeCompare(right)));
}

function validateAdmission(
  value: unknown,
  path: string,
  issues: string[]
): AdmissionConfiguration {
  const raw = value === undefined ? {} : value;
  if (!isRecord(raw)) {
    issues.push(`${path} must be a mapping`);
    return defaultAdmission();
  }
  rejectUnknownKeys(raw, ADMISSION_KEYS, path, issues);
  const mode = raw.mode === undefined ? "steer" : raw.mode;
  if (mode !== "steer" && mode !== "queue") {
    issues.push(`${path}.mode must equal steer or queue`);
  }
  return {
    mode: mode === "queue" ? "queue" : "steer",
    maximumActiveTurns: integerWithin(
      raw.maximumActiveTurns,
      1,
      1,
      64,
      `${path}.maximumActiveTurns`,
      issues
    ),
    queueCapacity: integerWithin(raw.queueCapacity, 16, 0, 10_000, `${path}.queueCapacity`, issues),
    maximumQueueAgeMs: integerWithin(
      raw.maximumQueueAgeMs,
      300_000,
      1_000,
      86_400_000,
      `${path}.maximumQueueAgeMs`,
      issues
    ),
    accountRateLimit: integerWithin(
      raw.accountRateLimit,
      30,
      1,
      100_000,
      `${path}.accountRateLimit`,
      issues
    ),
    accountRateWindowMs: integerWithin(
      raw.accountRateWindowMs,
      60_000,
      1_000,
      3_600_000,
      `${path}.accountRateWindowMs`,
      issues
    )
  };
}

function defaultAdmission(): AdmissionConfiguration {
  return {
    mode: "steer",
    maximumActiveTurns: 1,
    queueCapacity: 16,
    maximumQueueAgeMs: 300_000,
    accountRateLimit: 30,
    accountRateWindowMs: 60_000
  };
}

function validateAccessPolicy(
  value: unknown,
  path: string,
  issues: string[]
): ChannelAccessPolicyConfiguration {
  const raw = value === undefined ? {} : value;
  if (!isRecord(raw)) {
    issues.push(`${path} must be a mapping`);
    return denyAccessPolicy();
  }
  rejectUnknownKeys(raw, ACCESS_POLICY_KEYS, path, issues);
  return {
    privateChats: validateAccessRule(raw.privateChats, `${path}.privateChats`, issues),
    groupChats: validateAccessRule(raw.groupChats, `${path}.groupChats`, issues),
    groupParticipants: validateAccessRule(
      raw.groupParticipants,
      `${path}.groupParticipants`,
      issues
    )
  };
}

function validateAccessRule(
  value: unknown,
  path: string,
  issues: string[]
): AccessRuleConfiguration {
  const raw = value === undefined ? {} : value;
  if (!isRecord(raw)) {
    issues.push(`${path} must be a mapping`);
    return { mode: "deny", allow: [] };
  }
  rejectUnknownKeys(raw, ACCESS_RULE_KEYS, path, issues);
  const mode = raw.mode === undefined ? "deny" : raw.mode;
  if (mode !== "deny" && mode !== "allowlist" && mode !== "open") {
    issues.push(`${path}.mode must equal deny, allowlist, or open`);
  }
  const allow = Array.isArray(raw.allow) ? raw.allow : [];
  if (raw.allow !== undefined && !Array.isArray(raw.allow)) {
    issues.push(`${path}.allow must be an array`);
  }
  const normalized: string[] = [];
  for (const [index, entry] of allow.entries()) {
    if (typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry, "utf8") > 8192) {
      issues.push(`${path}.allow.${index} must be a non-empty provider identifier`);
    } else if (normalized.includes(entry)) {
      issues.push(`${path}.allow.${index} is duplicated`);
    } else {
      normalized.push(entry);
    }
  }
  if (mode === "allowlist" && normalized.length === 0) {
    issues.push(`${path}.allow must not be empty in allowlist mode`);
  }
  if ((mode === "deny" || mode === "open") && normalized.length > 0) {
    issues.push(`${path}.allow is only valid in allowlist mode`);
  }
  return {
    mode: mode === "allowlist" || mode === "open" ? mode : "deny",
    allow: normalized
  };
}

function denyAccessPolicy(): ChannelAccessPolicyConfiguration {
  return {
    privateChats: { mode: "deny", allow: [] },
    groupChats: { mode: "deny", allow: [] },
    groupParticipants: { mode: "deny", allow: [] }
  };
}

function secretReference(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string") {
    issues.push(`${path} must be a Secret Reference`);
    return null;
  }
  if (value.startsWith("env:") && ENVIRONMENT_NAME.test(value.slice(4))) return value;
  if (value.startsWith("file:") && isAbsolute(value.slice(5))) return value;
  issues.push(`${path} must be an env:NAME or file:/absolute/path Secret Reference`);
  return null;
}

function rejectDuplicateDeclaredChannelAccountIds(
  profiles: Record<string, unknown>,
  issues: string[]
): void {
  const owners = new Map<string, string>();
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (!isRecord(profile) || !isRecord(profile.channelAccounts)) continue;
    for (const accountId of Object.keys(profile.channelAccounts)) {
      const previous = owners.get(accountId);
      if (previous) {
        issues.push(
          `profiles.${profileId}.channelAccounts.${accountId} duplicates Profile ${previous}`
        );
      } else {
        owners.set(accountId, profileId);
      }
    }
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not supported`);
  }
}

function absolutePath(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    issues.push(`${path} must be an absolute path`);
    return null;
  }
  return normalize(value);
}

function optionalExecutablePath(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || !isAbsolute(value)) {
    issues.push(`${path} must be an absolute path`);
    return undefined;
  }
  return normalize(value);
}

function integerWithin(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  path: string,
  issues: string[]
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    issues.push(`${path} must be an integer from ${minimum} through ${maximum}`);
    return fallback;
  }
  return value;
}

function rejectOverlappingOwnedPaths(
  profiles: Record<string, ProfileConfiguration>,
  issues: string[]
): void {
  const fields = ["workspace", "codexHome", "stateDirectory"] as const;
  const paths = Object.values(profiles).flatMap((profile) =>
    fields.map((field) => ({ profileId: profile.id, field, path: profile[field] }))
  );
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    const left = paths[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const right = paths[rightIndex];
      if (!right || !pathsOverlap(left.path, right.path)) continue;
      issues.push(
        `profiles.${left.profileId}.${left.field} overlaps profiles.${right.profileId}.${right.field}`
      );
    }
  }
}

function rejectOverlappingSecretFiles(
  profiles: Record<string, ProfileConfiguration>,
  issues: string[]
): void {
  const values = Object.values(profiles);
  for (const [index, profile] of values.entries()) {
    const secretInsideOwnState = pathContains(profile.stateDirectory, profile.secretsFile);
    if (!secretInsideOwnState && pathsOverlap(profile.stateDirectory, profile.secretsFile)) {
      issues.push(`profiles.${profile.id}.secretsFile overlaps its stateDirectory boundary`);
    }
    for (let otherIndex = index + 1; otherIndex < values.length; otherIndex += 1) {
      const other = values[otherIndex];
      if (!other) continue;
      if (pathsOverlap(profile.secretsFile, other.secretsFile)) {
        issues.push(`profiles.${profile.id}.secretsFile overlaps profiles.${other.id}.secretsFile`);
      }
      for (const field of ["workspace", "codexHome", "stateDirectory"] as const) {
        if (pathsOverlap(profile.secretsFile, other[field])) {
          issues.push(`profiles.${profile.id}.secretsFile overlaps profiles.${other.id}.${field}`);
        }
        if (pathsOverlap(other.secretsFile, profile[field])) {
          issues.push(`profiles.${other.id}.secretsFile overlaps profiles.${profile.id}.${field}`);
        }
      }
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function deepMerge(base: unknown, override: Record<string, unknown>): unknown {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (isRecord(base)) {
    for (const [key, value] of Object.entries(base)) result[key] = value;
  }
  for (const [key, value] of Object.entries(override)) {
    result[key] = isRecord(value) && isRecord(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

function containsReservedObjectKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReservedObjectKey);
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return true;
    if (containsReservedObjectKey(nested)) return true;
  }
  return false;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
