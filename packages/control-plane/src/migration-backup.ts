import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { asRecord } from "./protocol.js";

const MAX_MANIFEST_BYTES = 64 * 1024;

export interface MigrationBackupManifest {
  readonly schemaVersion: 1;
  readonly kind: "codex-channel-bridge-profile-snapshot";
  readonly profileId: string;
  readonly sourceDigest: string;
  readonly completedAtMs: number;
}

export async function readMigrationBackupManifest(
  absolutePath: string,
  expected: { readonly profileId: string; readonly sourceDigest: string }
): Promise<MigrationBackupManifest> {
  if (!isAbsolute(absolutePath)) throw new Error("Backup manifest path must be absolute");
  const file = await lstat(absolutePath);
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_MANIFEST_BYTES) {
    throw new Error("Backup manifest must be a bounded regular file");
  }
  if (
    process.platform !== "win32" &&
    (file.uid !== process.getuid?.() || (file.mode & 0o777) !== 0o600)
  ) {
    throw new Error("Backup manifest must be owner-only");
  }
  const parsed = asRecord(JSON.parse(await readFile(absolutePath, "utf8")));
  const keys = parsed ? Object.keys(parsed).sort() : [];
  if (
    !parsed ||
    keys.join(",") !== "completedAtMs,kind,profileId,schemaVersion,sourceDigest" ||
    parsed.schemaVersion !== 1 ||
    parsed.kind !== "codex-channel-bridge-profile-snapshot" ||
    parsed.profileId !== expected.profileId ||
    parsed.sourceDigest !== expected.sourceDigest ||
    !Number.isSafeInteger(parsed.completedAtMs) ||
    (parsed.completedAtMs as number) <= 0
  ) {
    throw new Error("Backup manifest does not match the planned Profile snapshot");
  }
  return parsed as unknown as MigrationBackupManifest;
}
