import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ChannelDeliveryError, validOutputFile, type OutputFile } from "@codex-channel-bridge/core";
import { assertWindowsOwnerOnlyPath, secureWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

export const OUTPUT_FILE_LIMIT = 64 * 1024 * 1024;

/** Deliberately narrow Markdown subset: ordinary inline local links only. */
export function outputFileLinks(text: string): readonly string[] {
  if (/<(?:pre|code|script|style)\b|<!--/i.test(text)) return [];
  const paths = new Set<string>();
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = fenceMatch?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && !fenceMatch![2]!.trim()) fence = undefined;
      continue;
    }
    // ponytail: skip ambiguous Markdown lines; use a parser if richer link syntax is required.
    if (fence || /`|^\s{4}|^\s*>/.test(line)) continue;
    for (const match of line.matchAll(/!?\[[^\[\]\n]{1,500}\]\((?:<([^<>\n]+)>|([^\s()<>]+))\)/g)) {
      if (match.index > 0 && line[match.index - 1] === "\\") continue;
      const path = match[1] ?? match[2]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) continue;
      if (/[?#\x00-\x1f\x7f]/.test(path) || path.startsWith("//") || path.startsWith("\\\\")) continue;
      paths.add(path);
      if (paths.size === 4) return [...paths]; // fourth entry reports the three-file ceiling
    }
  }
  return [...paths];
}

export async function outputStoredBytes(directory: string): Promise<number> {
  let entries;
  try { entries = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  await requireOwner(directory, true);
  let bytes = 0;
  // ponytail: linear scan of retained snapshots; add an index if this becomes operationally expensive.
  for (const name of entries) {
    const stat = await lstat(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_output_snapshot");
    bytes += stat.size; // count orphaned temporary snapshots too; no implicit deletion
  }
  return bytes;
}

export async function snapshotOutputFile(options: {
  workspace: string; path: string; excludedPaths: readonly string[];
  directory: string; limitBytes: number;
}): Promise<OutputFile> {
  const workspace = await realpath(options.workspace);
  const candidate = resolve(workspace, options.path);
  const parts = relative(workspace, candidate).split(sep);
  if (!inside(workspace, candidate) || parts.some((part) =>
    part.startsWith(".") || part.includes(":") || /(?:^|[._-])(?:env|secrets?|credentials?|auth|id_rsa|id_ed25519)(?:[._-]|$)|\.(?:pem|key|p12|pfx|ppk)$/i.test(part))) {
    throw new Error("output_path_rejected");
  }
  for (const excluded of options.excludedPaths) {
    const path = await realpath(excluded).catch(() => resolve(excluded));
    if (candidate === path || inside(path, candidate)) throw new Error("output_path_rejected");
  }
  let current = workspace;
  for (const part of parts) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("output_path_rejected");
  }
  const original = await lstat(candidate);
  if (!original.isFile() || original.nlink !== 1 || original.size <= 0 ||
      original.size > Math.min(options.limitBytes, OUTPUT_FILE_LIMIT)) throw new Error("output_file_limit");
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (before.dev !== original.dev || before.ino !== original.ino || !before.isFile() ||
        await realpath(candidate) !== candidate) throw new Error("output_path_changed");
    bytes = Buffer.alloc(original.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw new Error("output_file_changed");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== original.size || after.mtimeMs !== original.mtimeMs ||
        after.ctimeMs !== original.ctimeMs || after.nlink !== 1) throw new Error("output_file_changed");
  } finally { await handle.close(); }
  const file = { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, filename: basename(candidate) };
  if (!validOutputFile(file)) throw new Error("output_file_rejected");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const destination = await lstat(options.directory);
  if (!destination.isDirectory() || destination.isSymbolicLink()) throw new Error("insecure_output_directory");
  if (process.platform === "win32") secureWindowsOwnerOnlyPath(options.directory, "directory");
  await requireOwner(options.directory, true);
  const target = join(options.directory, file.sha256);
  try { await readOutputFile(options.directory, file); return file; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(options.directory, randomUUID());
  const output = await open(temporary, "wx", 0o600);
  try {
    if (process.platform === "win32") secureWindowsOwnerOnlyPath(temporary, "file");
    await output.writeFile(bytes);
    await output.sync();
    await output.close();
    await rename(temporary, target);
    if (process.platform !== "win32") {
      const dir = await open(options.directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally { await output.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  return file;
}

export async function readOutputFile(directory: string, file: OutputFile): Promise<Uint8Array> {
  if (!validOutputFile(file)) throw new ChannelDeliveryError("rejected", "Invalid output snapshot");
  await requireOwner(directory, true);
  const path = join(directory, file.sha256);
  const stat = await requireOwner(path, false);
  if (stat.size !== file.sizeBytes) throw new ChannelDeliveryError("rejected", "Output snapshot changed");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(file.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length || (await handle.stat()).size !== file.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new ChannelDeliveryError("rejected", "Output snapshot changed");
    }
    return bytes;
  } finally { await handle.close(); }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function requireOwner(path: string, directory: boolean) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
    throw new ChannelDeliveryError("rejected", "Insecure output snapshot");
  }
  if (process.platform === "win32") assertWindowsOwnerOnlyPath(path, directory ? "directory" : "file");
  return stat;
}
