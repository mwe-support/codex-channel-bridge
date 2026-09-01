import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export async function writeOwnerOnlyExclusiveFile(path: string, contents: string): Promise<void> {
  requireAbsolute(path);
  await requireOwnerDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
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
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700))
  ) throw new Error("Output directory is not owner-only");
  await syncDirectory(dirname(path));
}

export async function writeOwnerOnlyFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireOwnerDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Output parent is invalid");
  if (
    process.platform !== "win32" &&
    (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)
  ) throw new Error("Output parent must be owner-only");
}

async function syncDirectory(path: string): Promise<void> {
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
