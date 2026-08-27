import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap
} from "baileys";

const MAX_AUTH_FILE_BYTES = 16 * 1024 * 1024;
const CREDS_FILE = "creds.json";
const ACTIVE_GENERATION_FILE = "active-generation.json";
const GENERATIONS_DIRECTORY = "generations";
const GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OpenBaileysAuthStateOptions {
  readonly directoryPath: string;
  readonly createIfMissing?: boolean;
}

export interface BaileysAuthStateHandle {
  readonly state: object;
  readonly saveCredentials: () => Promise<void>;
}

export interface BaileysAuthGenerationHandle extends BaileysAuthStateHandle {
  readonly generationId: string;
  readonly directoryPath: string;
}

export interface BaileysAuthGenerationRootOptions {
  readonly rootDirectoryPath: string;
}

/** Create an unpaired generation without changing the active authentication. */
export async function createStagedBaileysAuthState(
  options: BaileysAuthGenerationRootOptions
): Promise<BaileysAuthGenerationHandle> {
  await prepareGenerationRoot(options.rootDirectoryPath, true);
  const generationId = randomUUID();
  const directoryPath = generationPath(options.rootDirectoryPath, generationId);
  await mkdir(directoryPath, { mode: 0o700, recursive: false });
  const handle = await openBaileysAuthState({ directoryPath, createIfMissing: true });
  return { ...handle, generationId, directoryPath };
}

/** Open only the generation selected by the atomically replaced active marker. */
export async function openActiveBaileysAuthState(
  options: BaileysAuthGenerationRootOptions
): Promise<BaileysAuthGenerationHandle> {
  await prepareGenerationRoot(options.rootDirectoryPath, false);
  const generationId = await readActiveGenerationId(options.rootDirectoryPath);
  if (!generationId) {
    throw new Error("Active Baileys authentication generation is missing");
  }
  const directoryPath = generationPath(options.rootDirectoryPath, generationId);
  const handle = await openBaileysAuthState({ directoryPath });
  return { ...handle, generationId, directoryPath };
}

/**
 * Activate a fully registered staged generation by replacing one small marker
 * file. Existing generations remain untouched for explicit lifecycle cleanup.
 */
export async function activateBaileysAuthGeneration(
  options: BaileysAuthGenerationRootOptions & { readonly generationId: string }
): Promise<{ readonly previousGenerationId: string | null }> {
  await prepareGenerationRoot(options.rootDirectoryPath, false);
  const directoryPath = generationPath(options.rootDirectoryPath, options.generationId);
  const handle = await openBaileysAuthState({ directoryPath });
  if (!(handle.state as AuthenticationState).creds.registered) {
    throw new Error("Baileys authentication generation is not registered");
  }
  const previousGenerationId = await readActiveGenerationId(options.rootDirectoryPath, true);
  await writeJsonAtomically(join(options.rootDirectoryPath, ACTIVE_GENERATION_FILE), {
    generationId: options.generationId
  });
  return { previousGenerationId };
}

/** Delete only a non-active staged generation created inside this auth root. */
export async function discardBaileysAuthGeneration(
  options: BaileysAuthGenerationRootOptions & { readonly generationId: string }
): Promise<void> {
  await prepareGenerationRoot(options.rootDirectoryPath, false);
  const activeGenerationId = await readActiveGenerationId(options.rootDirectoryPath, true);
  if (activeGenerationId === options.generationId) {
    throw new Error("Active Baileys authentication generation cannot be discarded");
  }
  const directoryPath = generationPath(options.rootDirectoryPath, options.generationId);
  const metadata = await lstat(directoryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Staged Baileys authentication generation must be a real directory");
  }
  requireOwnerMode(metadata.uid, metadata.mode, 0o700, "Baileys authentication generation");
  await rm(directoryPath, { recursive: true, force: false });
}

/**
 * Profile-local auth state with owner-only files and atomic replacement. The
 * caller chooses whether an unpaired state may be created, allowing pairing to
 * stage in a separate directory before an administrator activates it.
 */
export async function openBaileysAuthState(
  options: OpenBaileysAuthStateOptions
): Promise<BaileysAuthStateHandle> {
  if (!isAbsolute(options.directoryPath)) {
    throw new Error("Baileys authentication directory must be absolute");
  }
  await prepareDirectory(options.directoryPath, options.createIfMissing === true);
  const credsPath = join(options.directoryPath, CREDS_FILE);
  let creds = await readJson<AuthenticationCreds>(credsPath);
  if (!creds) {
    if (!options.createIfMissing) {
      throw new Error("Baileys authentication credentials are missing");
    }
    creds = initAuthCreds();
    await writeJsonAtomically(credsPath, creds);
  }

  const fileLocks = new Map<string, Promise<void>>();
  const withLock = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
    const previous = fileLocks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    fileLocks.set(path, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (fileLocks.get(path) === tail) fileLocks.delete(path);
    }
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const values = {} as { [id: string]: SignalDataTypeMap[T] };
        await Promise.all(ids.map(async (id) => {
          const path = keyPath(options.directoryPath, type, id);
          const value = await withLock(path, () => readJson<SignalDataTypeMap[T]>(path));
          if (value !== null) {
            values[id] = type === "app-state-sync-key"
              ? proto.Message.AppStateSyncKeyData.fromObject(
                  value as unknown as proto.Message.IAppStateSyncKeyData
                ) as unknown as SignalDataTypeMap[T]
              : value;
          }
        }));
        return values;
      },
      set: async (data: SignalDataSet) => {
        const operations: Promise<void>[] = [];
        for (const rawType of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
          const entries = data[rawType];
          if (!entries) continue;
          for (const [id, value] of Object.entries(entries)) {
            const path = keyPath(options.directoryPath, rawType, id);
            operations.push(withLock(path, async () => {
              if (value === null) await removeRegularFile(path);
              else await writeJsonAtomically(path, value);
            }));
          }
        }
        await Promise.all(operations);
      },
      clear: async () => {
        throw new Error("Baileys authentication clearing requires the explicit revoke workflow");
      }
    }
  };

  return {
    state,
    saveCredentials: () => withLock(credsPath, () => writeJsonAtomically(credsPath, state.creds))
  };
}

async function prepareDirectory(path: string, createIfMissing: boolean): Promise<void> {
  let metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata && createIfMissing) {
    await mkdir(path, { mode: 0o700, recursive: false });
    metadata = await lstat(path);
  }
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Baileys authentication path must be a real directory");
  }
  requireOwnerMode(metadata.uid, metadata.mode, 0o700, "Baileys authentication directory");
}

async function prepareGenerationRoot(path: string, createIfMissing: boolean): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error("Baileys authentication generation root must be absolute");
  }
  await prepareDirectory(path, createIfMissing);
  await prepareDirectory(join(path, GENERATIONS_DIRECTORY), createIfMissing);
}

async function readActiveGenerationId(
  rootDirectoryPath: string,
  allowMissing = false
): Promise<string | null> {
  const marker = await readJson<{ readonly generationId?: unknown }>(
    join(rootDirectoryPath, ACTIVE_GENERATION_FILE)
  );
  if (!marker) {
    if (allowMissing) return null;
    throw new Error("Active Baileys authentication generation is missing");
  }
  if (typeof marker.generationId !== "string" || !GENERATION_ID_PATTERN.test(marker.generationId)) {
    throw new Error("Active Baileys authentication generation is malformed");
  }
  return marker.generationId;
}

function generationPath(rootDirectoryPath: string, generationId: string): string {
  if (!GENERATION_ID_PATTERN.test(generationId)) {
    throw new Error("Baileys authentication generation ID is invalid");
  }
  return join(rootDirectoryPath, GENERATIONS_DIRECTORY, generationId);
}

async function readJson<T>(path: string): Promise<T | null> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Baileys authentication input must be a regular non-symlink file");
  }
  requireOwnerMode(metadata.uid, metadata.mode, 0o600, "Baileys authentication file");
  if (metadata.size > MAX_AUTH_FILE_BYTES) {
    throw new Error("Baileys authentication file exceeds the size limit");
  }
  const text = await readFile(path, "utf8");
  if (!text) throw new Error("Baileys authentication file is empty");
  try {
    return JSON.parse(text, BufferJSON.reviver) as T;
  } catch {
    throw new Error("Baileys authentication file is malformed");
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await validateWritableTarget(path);
  const payload = JSON.stringify(value, BufferJSON.replacer);
  if (Buffer.byteLength(payload, "utf8") > MAX_AUTH_FILE_BYTES) {
    throw new Error("Baileys authentication value exceeds the size limit");
  }
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  if (process.platform !== "win32") {
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

async function validateWritableTarget(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Baileys authentication target must be a regular non-symlink file");
  }
  requireOwnerMode(metadata.uid, metadata.mode, 0o600, "Baileys authentication file");
}

async function removeRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Baileys authentication key target is not a regular file");
  }
  requireOwnerMode(metadata.uid, metadata.mode, 0o600, "Baileys authentication file");
  await unlink(path);
}

function keyPath(
  directoryPath: string,
  type: keyof SignalDataTypeMap,
  id: string
): string {
  const encoded = Buffer.from(`${type}\0${id}`, "utf8").toString("base64url");
  return join(directoryPath, `key-${encoded}.json`);
}

function requireOwnerMode(
  uid: number,
  mode: number,
  requiredMode: number,
  label: string
): void {
  if (process.platform === "win32") return;
  if (uid !== process.getuid?.() || (mode & 0o777) !== requiredMode) {
    throw new Error(`${label} must be owned by the service user with mode ${requiredMode.toString(8)}`);
  }
}
