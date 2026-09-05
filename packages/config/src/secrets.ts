import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { assertWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

const MAX_SECRET_FILE_BYTES = 1024 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SecretResolutionReason =
  | "invalid_secret_reference"
  | "insecure_secret_file"
  | "malformed_secret_file"
  | "secret_unavailable";

export class SecretResolutionError extends Error {
  public constructor(public readonly reason: SecretResolutionReason, message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

export interface SecretResolverOptions {
  readonly secretsFile?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export class SecretResolver {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #persistent: ReadonlyMap<string, string>;

  private constructor(
    environment: Readonly<Record<string, string | undefined>>,
    persistent: ReadonlyMap<string, string>
  ) {
    this.#environment = environment;
    this.#persistent = persistent;
  }

  public static async open(options: SecretResolverOptions = {}): Promise<SecretResolver> {
    const environment = options.environment ?? process.env;
    let persistent = new Map<string, string>();
    if (options.secretsFile !== undefined) {
      if (!isAbsolute(options.secretsFile)) {
        throw new SecretResolutionError(
          "insecure_secret_file",
          "Persistent secret file must use an absolute path"
        );
      }
      const contents = await readSecureSecretFile(options.secretsFile, true);
      if (contents !== null) persistent = parseDotenv(contents);
    }
    return new SecretResolver(environment, persistent);
  }

  public async resolve(reference: string): Promise<string> {
    if (reference.startsWith("env:")) {
      const name = reference.slice(4);
      if (!ENVIRONMENT_NAME.test(name)) invalidReference();
      if (Object.hasOwn(this.#environment, name)) {
        const value = this.#environment[name];
        if (!value) unavailable();
        return value;
      }
      const value = this.#persistent.get(name);
      if (!value) unavailable();
      return value;
    }
    if (reference.startsWith("file:")) {
      const path = reference.slice(5);
      if (!isAbsolute(path)) invalidReference();
      const contents = await readSecureSecretFile(path, false);
      if (contents === null) unavailable();
      return parseSingleSecret(contents);
    }
    invalidReference();
  }
}

async function readSecureSecretFile(path: string, missingAllowed: boolean): Promise<string | null> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if (missingAllowed && isNodeError(error) && error.code === "ENOENT") return null;
    return unavailable();
  }
  if (!before.isFile() || before.isSymbolicLink()) insecureFile();
  assertOwnerOnly(before.uid, before.mode);
  try { assertWindowsOwnerOnlyPath(path, "file"); } catch { insecureFile(); }

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) insecureFile();
    assertOwnerOnly(current.uid, current.mode);
    try { assertWindowsOwnerOnlyPath(path, "file"); } catch { insecureFile(); }
    if (current.size < 1 || current.size > MAX_SECRET_FILE_BYTES) malformedFile();
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof SecretResolutionError) throw error;
    return unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertOwnerOnly(uid: number, mode: number): void {
  if (
    process.platform !== "win32" &&
    (uid !== process.getuid?.() || (mode & 0o777) !== 0o600)
  ) {
    insecureFile();
  }
}

function parseDotenv(contents: string): Map<string, string> {
  if (contents.includes("\0")) malformedFile();
  const values = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) malformedFile();
    const name = match[1];
    if (!name || values.has(name)) malformedFile();
    const value = parseDotenvValue(match[2] ?? "");
    if (!value) malformedFile();
    values.set(name, value);
  }
  return values;
}

function parseDotenvValue(raw: string): string {
  if (!raw) return "";
  const first = raw[0];
  if (first === '"' || first === "'") {
    if (raw.length < 2 || raw.at(-1) !== first) malformedFile();
    const inner = raw.slice(1, -1);
    if (inner.includes("\n") || inner.includes("\r")) malformedFile();
    return inner;
  }
  if (raw.includes("\r") || raw.includes("\n")) malformedFile();
  return raw.trim();
}

function parseSingleSecret(contents: string): string {
  if (contents.includes("\0")) malformedFile();
  const value = contents.replace(/\r?\n$/u, "");
  if (!value || value.includes("\n") || value.includes("\r")) malformedFile();
  return value;
}

function invalidReference(): never {
  throw new SecretResolutionError("invalid_secret_reference", "Secret Reference is invalid");
}

function insecureFile(): never {
  throw new SecretResolutionError("insecure_secret_file", "Secret file is insecure");
}

function malformedFile(): never {
  throw new SecretResolutionError("malformed_secret_file", "Secret file is malformed");
}

function unavailable(): never {
  throw new SecretResolutionError("secret_unavailable", "Secret value is unavailable");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
