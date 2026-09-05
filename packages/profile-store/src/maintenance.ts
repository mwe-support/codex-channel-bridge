import { lstat } from "node:fs/promises";

import Database from "better-sqlite3";
import { assertWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

export interface ProfileStoreCheckpoint {
  readonly busy: number;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
}

/** Explicit stopped-Profile WAL checkpoint used only by host-local maintenance. */
export async function checkpointProfileStore(options: {
  readonly profileId: string;
  readonly databasePath: string;
}): Promise<ProfileStoreCheckpoint> {
  const metadata = await lstat(options.databasePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Profile database is not a regular file");
  }
  if (
    process.platform !== "win32" &&
    (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600)
  ) throw new Error("Profile database is not owner-only");
  assertWindowsOwnerOnlyPath(options.databasePath, "file");
  const database = new Database(options.databasePath, { fileMustExist: true, timeout: 5_000 });
  try {
    const profile = database.prepare(
      "SELECT profile_id FROM profile_metadata WHERE singleton = 1"
    ).get() as { profile_id?: string } | undefined;
    if (profile?.profile_id !== options.profileId) throw new Error("Profile database identity does not match");
    const row = (database.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>)[0];
    if (!row || row.busy !== 0) throw new Error("Profile database WAL checkpoint remained busy");
    return {
      busy: row.busy,
      logFrames: row.log,
      checkpointedFrames: row.checkpointed
    };
  } finally {
    database.close();
  }
}
