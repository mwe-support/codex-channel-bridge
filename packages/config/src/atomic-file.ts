import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { assertWindowsOwnerOnlyPath, secureWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

const MAX_BYTES = 1024 * 1024;

/** Locks cooperating writers and detects external edits before atomic publication. */
export async function updateOwnerOnlyFile(
  path: string,
  update: (previous: string | null) => string | Promise<string>
): Promise<void> {
  if (!isAbsolute(path)) throw new Error("An absolute file path is required");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== "win32" &&
    (parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0))) {
    throw new Error("File directory must be owned by the current identity and protected from other writers");
  }
  if (process.platform === "win32") assertWindowsOwnerOnlyPath(dirname(path), "directory");
  const lock = `${path}.lock`;
  await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error("File is locked; retry after the other writer finishes"); });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    secureWindowsOwnerOnlyPath(lock, "directory");
    const previous = await readOwnerOnlyFile(path);
    const next = await update(previous);
    if (Buffer.byteLength(next, "utf8") > MAX_BYTES) throw new Error("File exceeds the 1 MiB limit");
    const handle = await open(temporary, "wx", 0o600);
    try {
      secureWindowsOwnerOnlyPath(temporary, "file");
      await handle.writeFile(next, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    if (await readOwnerOnlyFile(path) !== previous) throw new Error("File changed while preparing the update; retry");
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    try { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    finally { await rmdir(lock); }
  }
}

export async function readOwnerOnlyFile(path: string): Promise<string | null> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (before === null) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES ||
    (process.platform !== "win32" && (before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0))) {
    throw new Error("File must be regular, owned by the current identity, and owner-only");
  }
  assertWindowsOwnerOnlyPath(path, "file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.size > MAX_BYTES ||
      (process.platform !== "win32" && (current.uid !== process.getuid?.() || (current.mode & 0o077) !== 0))) {
      throw new Error("File changed while reading");
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
