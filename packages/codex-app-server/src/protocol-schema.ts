import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CodexVerification, ProfileReasonCode } from "@codex-channel-bridge/core";

const execFileAsync = promisify(execFile);

// Historical acceptance evidence, never an executable allowlist.
const TESTED_PROTOCOL_SNAPSHOTS = [{
  cliVersion: "0.149.1",
  schemaSha256: "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9"
}] as const;

export const REQUIRED_STABLE_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/read",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "model/list"
] as const;

export const OPTIONAL_METHODS = ["thread/settings/update"] as const;

export interface ProtocolProbeResult {
  readonly cliVersion: string;
  readonly verification: CodexVerification;
  readonly schemaSha256: string;
  readonly requiredMethods: readonly string[];
  readonly optionalMethods: readonly string[];
}

export class CodexProtocolProbeError extends Error {
  public constructor(public readonly reason: Exclude<ProfileReasonCode, null>, message: string) {
    super(message);
    this.name = "CodexProtocolProbeError";
  }
}

export function extractProtocolMethods(schema: unknown): Set<string> {
  const methods = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const method = value.method;
    if (isRecord(method) && Array.isArray(method.enum)) {
      for (const candidate of method.enum) {
        if (typeof candidate === "string") methods.add(candidate);
      }
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(schema);
  return methods;
}

export function assessProtocolSchema(
  cliVersion: string,
  schema: unknown,
  schemaSha256?: string
): ProtocolProbeResult {
  const methods = extractProtocolMethods(schema);
  const missing = REQUIRED_STABLE_METHODS.filter((method) => !methods.has(method));
  if (missing.length > 0) {
    throw new CodexProtocolProbeError(
      "incompatible_codex_protocol",
      `Codex App Server is missing required stable methods: ${missing.join(", ")}`
    );
  }

  const verification: CodexVerification =
    TESTED_PROTOCOL_SNAPSHOTS.some((snapshot) =>
      snapshot.cliVersion === cliVersion && snapshot.schemaSha256 === schemaSha256
    )
      ? "tested"
      : "unverified";
  return {
    cliVersion,
    verification,
    schemaSha256: schemaSha256 ?? "not-computed",
    requiredMethods: [...REQUIRED_STABLE_METHODS],
    optionalMethods: OPTIONAL_METHODS.filter((method) => methods.has(method))
  };
}

export async function probeCodexProtocol(
  codexExecutable = "codex",
  timeoutMs = 30_000
): Promise<ProtocolProbeResult> {
  const directory = await mkdtemp(join(tmpdir(), "codex-channel-bridge-schema-"));
  try {
    let versionOutput: string;
    try {
      const result = await execFileAsync(codexExecutable, ["--version"], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      });
      versionOutput = result.stdout;
    } catch (error) {
      if (isMissingExecutable(error)) {
        throw new CodexProtocolProbeError("codex_not_found", "Unable to execute the administrator-supplied Codex CLI");
      }
      versionOutput = "";
    }

    const cliVersion = parseCliVersion(versionOutput) ?? "unknown";

    try {
      await execFileAsync(
        codexExecutable,
        ["app-server", "generate-json-schema", "--out", directory],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 }
      );
    } catch {
      throw new CodexProtocolProbeError(
        "incompatible_codex_protocol",
        "Codex CLI could not generate the stable App Server schema"
      );
    }

    const bundle = await readFile(join(directory, "codex_app_server_protocol.v2.schemas.json"));
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    const schema = JSON.parse(bundle.toString("utf8")) as unknown;
    const stable = assessProtocolSchema(cliVersion, schema, sha256);
    const experimentalMethods = await probeExperimentalMethods(
      codexExecutable,
      directory,
      timeoutMs
    );
    return { ...stable, optionalMethods: [...new Set([...stable.optionalMethods, ...experimentalMethods])] };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function probeExperimentalMethods(
  codexExecutable: string,
  directory: string,
  timeoutMs: number
): Promise<readonly string[]> {
  const experimentalDirectory = join(directory, "experimental");
  try {
    await execFileAsync(
      codexExecutable,
      ["app-server", "generate-json-schema", "--experimental", "--out", experimentalDirectory],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 }
    );
    const bundle = await readFile(
      join(experimentalDirectory, "codex_app_server_protocol.v2.schemas.json")
    );
    const methods = extractProtocolMethods(JSON.parse(bundle.toString("utf8")) as unknown);
    return OPTIONAL_METHODS.filter((method) => methods.has(method));
  } catch {
    return [];
  }
}

function parseCliVersion(output: string): string | null {
  return output.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)*)/)?.[1] ?? null;
}

function isMissingExecutable(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
