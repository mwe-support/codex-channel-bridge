import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { assertWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

const MAX_CONFIG_BYTES = 1024 * 1024;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const CHANNEL_ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const CHANNEL_ACCOUNT_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  readonly maximumActiveTurns: number | null;
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
  readonly sendOutputFiles?: boolean;
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

export function formatConfiguration(raw: unknown): string {
  const text = stringify(raw, { lineWidth: 0 });
  parseConfiguration(text);
  return text;
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
      } else if (process.platform === "win32") {
        try {
          assertWindowsOwnerOnlyPath(profile.stateDirectory, "directory", true);
        } catch {
          issues.push(`profiles.${profile.id}.stateDirectory must have an owner-only Windows ACL`);
        }
      }
    })
  );
  if (issues.length > 0) throw new ConfigurationValidationError(issues.sort());
}

function integer(minimum: number, maximum: number, fallback: number) {
  return z.number({ error: `must be an integer from ${minimum} through ${maximum}` })
    .int({ error: `must be an integer from ${minimum} through ${maximum}` })
    .min(minimum, { error: `must be an integer from ${minimum} through ${maximum}` })
    .max(maximum, { error: `must be an integer from ${minimum} through ${maximum}` })
    .default(fallback);
}

const absolutePathSchema = z.string({ error: "must be an absolute path" })
  .min(1, { error: "must be an absolute path" })
  .refine(isAbsolute, { error: "must be an absolute path" })
  .transform(normalize);
const secretReferenceSchema = z.string({ error: "must be a Secret Reference" }).refine(
  (value) =>
    (value.startsWith("env:") && ENVIRONMENT_NAME.test(value.slice(4))) ||
    (value.startsWith("file:") && isAbsolute(value.slice(5))),
  { error: "must be an env:NAME or file:/absolute/path Secret Reference" }
).transform((value) => value.startsWith("file:") ? `file:${normalize(value.slice(5))}` : value);
const defaultObject = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => value === undefined ? {} : value, schema);
const accessRuleSchema = defaultObject(z.strictObject({
  mode: z.enum(["deny", "allowlist", "open"], {
    error: "must equal deny, allowlist, or open"
  }).default("deny"),
  allow: z.array(
    z.string({ error: "must be a non-empty provider identifier" })
      .min(1, { error: "must be a non-empty provider identifier" })
      .refine((value) => Buffer.byteLength(value, "utf8") <= 8192, {
        error: "must be a non-empty provider identifier"
      })
  ).default([])
}).superRefine((value, context) => {
  const seen = new Set<string>();
  value.allow.forEach((entry, index) => {
    if (seen.has(entry)) context.addIssue({ code: "custom", path: ["allow", index], message: "is duplicated" });
    seen.add(entry);
  });
  if (value.mode === "allowlist" && value.allow.length === 0) {
    context.addIssue({ code: "custom", path: ["allow"], message: "must not be empty in allowlist mode" });
  }
  if (value.mode !== "allowlist" && value.allow.length > 0) {
    context.addIssue({ code: "custom", path: ["allow"], message: "is only valid in allowlist mode" });
  }
}));
const accessPolicySchema = defaultObject(z.strictObject({
  privateChats: accessRuleSchema,
  groupChats: accessRuleSchema,
  groupParticipants: accessRuleSchema
}));
const accountCommon = {
  enabled: z.boolean().default(true),
  epochId: z.string().regex(CHANNEL_ACCOUNT_EPOCH_PATTERN, { error: "is invalid" }),
  groupThreadScope: z.enum(["conversation", "participant"], {
    error: "must equal conversation or participant"
  }).default("conversation"),
  accessPolicy: accessPolicySchema
};
const channelAccountSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("qq"),
    ...accountCommon,
    appId: secretReferenceSchema,
    appSecret: secretReferenceSchema
  }),
  z.strictObject({ provider: z.literal("whatsapp"), ...accountCommon })
], { error: "provider must equal qq or whatsapp" });
const channelAccountsSchema = z.record(
  z.string().regex(CHANNEL_ACCOUNT_ID_PATTERN, { error: "is not a valid Channel Account ID" }),
  channelAccountSchema
).default({}).transform((accounts) => Object.fromEntries(
  Object.entries(accounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, account]) => [id, { id, ...account }])
));
const admissionSchema = defaultObject(z.strictObject({
  mode: z.enum(["steer", "queue"], { error: "must equal steer or queue" }).default("steer"),
  maximumActiveTurns: z.number().int().min(1).max(64).nullable().default(null),
  queueCapacity: integer(0, 10_000, 16),
  maximumQueueAgeMs: integer(1_000, 86_400_000, 300_000),
  accountRateLimit: integer(1, 100_000, 30),
  accountRateWindowMs: integer(1_000, 3_600_000, 60_000)
}));
const approvalSchema = defaultObject(z.strictObject({
  timeoutMs: integer(10_000, 3_600_000, 300_000),
  detail: z.enum(["minimal", "summary", "detailed"], {
    error: "must equal minimal, summary, or detailed"
  }).default("minimal")
}));
const mediaSchema = defaultObject(z.strictObject({
  sendOutputFiles: z.boolean().default(false),
  perAttachmentLimitBytes: integer(1, 1024 * 1024 * 1024 * 1024, 64 * 1024 * 1024),
  profileQuotaBytes: integer(1, Number.MAX_SAFE_INTEGER, 10 * 1024 * 1024 * 1024)
}).superRefine((value, context) => {
  if (value.profileQuotaBytes < value.perAttachmentLimitBytes) {
    context.addIssue({
      code: "custom",
      path: ["profileQuotaBytes"],
      message: "must be at least perAttachmentLimitBytes"
    });
  }
}));
const profileSchema = z.strictObject({
  enabled: z.boolean().default(true),
  workspace: absolutePathSchema,
  codexHome: absolutePathSchema,
  stateDirectory: absolutePathSchema,
  secretsFile: absolutePathSchema.optional(),
  channelAccounts: channelAccountsSchema,
  codexExecutable: absolutePathSchema.optional(),
  admission: admissionSchema,
  approval: approvalSchema,
  media: mediaSchema
}).transform((profile) => ({
  ...profile,
  secretsFile: profile.secretsFile ?? join(profile.stateDirectory, "secrets.env")
}));
const configurationSchema = z.strictObject({
  schemaVersion: z.literal(1, { error: "must equal 1" }),
  supervisor: defaultObject(z.strictObject({
    drainTimeoutMs: integer(1_000, 3_600_000, 300_000),
    childExitTimeoutMs: integer(1_000, 60_000, 10_000),
    codexRestartCooldownMs: integer(1_000, 3_600_000, 30_000),
    diskSafetyFloorBytes: integer(
      16 * 1024 * 1024,
      1024 * 1024 * 1024 * 1024,
      512 * 1024 * 1024
    )
  })),
  profiles: z.record(
    z.string().regex(PROFILE_ID_PATTERN, { error: "is not a valid Profile ID" }),
    profileSchema
  )
}).transform((configuration) => ({
  ...configuration,
  profiles: Object.fromEntries(
    Object.entries(configuration.profiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, profile]) => [id, { id, ...profile }])
  )
}));

function validateShape(raw: unknown): BridgeConfiguration {
  const issues: string[] = [];
  if (isRecord(raw) && isRecord(raw.profiles)) {
    rejectDuplicateDeclaredChannelAccountIds(raw.profiles, issues);
  }
  const parsed = configurationSchema.safeParse(raw);
  if (!parsed.success) issues.push(...formatZodIssues(parsed.error.issues));
  if (!parsed.success) throw new ConfigurationValidationError(issues.sort());
  const configuration: BridgeConfiguration = parsed.data;
  rejectOverlappingOwnedPaths(configuration.profiles, issues);
  rejectOverlappingSecretFiles(configuration.profiles, issues);
  if (issues.length > 0) throw new ConfigurationValidationError(issues.sort());
  return configuration;
}

function formatZodIssues(issues: readonly z.core.$ZodIssue[]): readonly string[] {
  return issues.flatMap((issue) => {
    const path = issue.path.length === 0 ? "config" : issue.path.join(".");
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `${path}.${key} is not supported`);
    }
    return [`${path} ${issue.message}`];
  });
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

function rejectOverlappingOwnedPaths(
  profiles: Readonly<Record<string, ProfileConfiguration>>,
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
  profiles: Readonly<Record<string, ProfileConfiguration>>,
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
