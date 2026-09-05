import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  assertWindowsOwnerOnlyPath,
  secureWindowsOwnerOnlyPath
} from "@codex-channel-bridge/platform";

export async function writeOwnerOnlyExclusiveFile(path: string, contents: string): Promise<void> {
  requireAbsolute(path);
  await requireOwnerDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await openSecuredNewFile(temporary);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await link(temporary, path);
    await unlink(temporary);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function createOwnerOnlyDirectory(path: string): Promise<void> {
  requireAbsolute(path);
  await requireOwnerDirectory(dirname(path));
  await mkdir(path, { mode: 0o700 });
  secureWindowsOwnerOnlyPath(path, "directory");
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700))
  ) throw new Error("Output directory is not owner-only");
  assertWindowsOwnerOnlyPath(path, "directory");
  await syncDirectory(dirname(path));
}

export async function writeOwnerOnlyFile(path: string, contents: string): Promise<void> {
  const handle = await openSecuredNewFile(path);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

export async function writeOwnerOnlyAtomicFile(path: string, contents: string): Promise<void> {
  requireAbsolute(path);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await requireOwnerDirectory(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const handle = await openSecuredNewFile(temporary);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function openSecuredNewFile(path: string): Promise<FileHandle> {
  const handle = await open(path, "wx", 0o600);
  try {
    secureWindowsOwnerOnlyPath(path, "file");
    return handle;
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

export async function appendOwnerOnlyFile(path: string, contents: string): Promise<void> {
  requireAbsolute(path);
  let handle;
  try {
    handle = await open(path, "ax", 0o600);
    try {
      secureWindowsOwnerOnlyPath(path, "file");
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await requireOwnerFile(path);
    handle = await open(path, "a");
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function requireOwnerDirectory(path: string, exactMode?: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Output parent is invalid");
  if (
    process.platform !== "win32" &&
    (metadata.uid !== process.getuid?.() ||
      (exactMode === undefined
        ? (metadata.mode & 0o077) !== 0
        : (metadata.mode & 0o777) !== exactMode))
  ) throw new Error("Output parent must be owner-only");
  assertWindowsOwnerOnlyPath(path, "directory");
}

export async function requireOwnerFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Owner-only file is invalid");
  if (
    process.platform !== "win32" &&
    (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600)
  ) throw new Error("File must be owner-only");
  assertWindowsOwnerOnlyPath(path, "file");
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireAbsolute(path: string): void {
  if (!isAbsolute(path)) throw new Error("Output path must be absolute");
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
