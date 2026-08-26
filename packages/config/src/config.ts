import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

import { parseDocument } from "yaml";

const MAX_CONFIG_BYTES = 1024 * 1024;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "supervisor", "profiles"]);
const SUPERVISOR_KEYS = new Set(["drainTimeoutMs", "childExitTimeoutMs"]);
const PROFILE_KEYS = new Set(["enabled", "workspace", "codexHome", "codexExecutable"]);

export interface ProfileConfiguration {
  readonly id: string;
  readonly enabled: boolean;
  readonly workspace: string;
  readonly codexHome: string;
  readonly codexExecutable?: string;
}

export interface SupervisorConfiguration {
  readonly drainTimeoutMs: number;
  readonly childExitTimeoutMs: number;
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
      const [workspace, codexHome] = await Promise.all([
        stat(profile.workspace).catch(() => null),
        stat(profile.codexHome).catch(() => null)
      ]);
      if (!workspace?.isDirectory()) issues.push(`profiles.${profile.id}.workspace must exist as a directory`);
      if (!codexHome?.isDirectory()) issues.push(`profiles.${profile.id}.codexHome must exist as a directory`);
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

  const profiles: Record<string, ProfileConfiguration> = {};
  if (!isRecord(raw.profiles)) {
    issues.push("profiles must be a mapping keyed by Profile ID");
  } else {
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
      const codexExecutable = optionalExecutablePath(
        value.codexExecutable,
        `profiles.${id}.codexExecutable`,
        issues
      );
      if (workspace && codexHome && typeof enabled === "boolean") {
        profiles[id] = {
          id,
          enabled,
          workspace,
          codexHome,
          ...(codexExecutable ? { codexExecutable } : {})
        };
      }
    }
  }

  rejectDuplicatePaths(profiles, "workspace", issues);
  rejectDuplicatePaths(profiles, "codexHome", issues);
  if (issues.length > 0) throw new ConfigurationValidationError(issues.sort());

  return {
    schemaVersion: 1,
    supervisor: { drainTimeoutMs, childExitTimeoutMs },
    profiles: Object.fromEntries(Object.entries(profiles).sort(([left], [right]) => left.localeCompare(right)))
  };
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

function rejectDuplicatePaths(
  profiles: Record<string, ProfileConfiguration>,
  field: "workspace" | "codexHome",
  issues: string[]
): void {
  const owners = new Map<string, string>();
  for (const profile of Object.values(profiles)) {
    const previous = owners.get(profile[field]);
    if (previous) issues.push(`profiles.${profile.id}.${field} duplicates Profile ${previous}`);
    else owners.set(profile[field], profile.id);
  }
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
