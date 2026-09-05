import { lstat } from "node:fs/promises";

import Database from "better-sqlite3";
import { assertWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

const CURRENT_SCHEMA_VERSION = 11;
const COUNT_TABLES = [
  "message_archive",
  "archive_attachments",
  "thread_bindings",
  "codex_input_correlations",
  "logical_results",
  "delivery_outbox",
  "approval_requests",
  "audit_records"
] as const;

export interface ProfileStoreInspection {
  readonly schemaVersion: number;
  readonly currentSchemaVersion: number;
  readonly migrationRequired: boolean;
  readonly quickCheck: "ok" | "failed";
  readonly databaseBytes: number;
  readonly profileMatches: boolean | null;
  readonly counts: Readonly<Record<(typeof COUNT_TABLES)[number], number | null>>;
}

/** Read-only Profile database inspection that does not require the current schema. */
export async function inspectProfileStore(options: {
  readonly profileId: string;
  readonly databasePath: string;
}): Promise<ProfileStoreInspection> {
  const metadata = await lstat(options.databasePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Profile database is not a regular file");
  }
  if (
    process.platform !== "win32" &&
    (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600)
  ) throw new Error("Profile database is not owner-only");
  assertWindowsOwnerOnlyPath(options.databasePath, "file");
  const database = new Database(options.databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000
  });
  try {
    const schemaVersion = database.pragma("user_version", { simple: true }) as number;
    const quickRows = database.pragma("quick_check") as readonly Record<string, unknown>[];
    const quickCheck = quickRows.length === 1 && quickRows[0]?.quick_check === "ok"
      ? "ok" as const
      : "failed" as const;
    const tables = new Set(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => (row as { name: string }).name)
    );
    const counts = Object.fromEntries(COUNT_TABLES.map((table) => [
      table,
      tables.has(table)
        ? (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
        : null
    ])) as Record<(typeof COUNT_TABLES)[number], number | null>;
    let profileMatches: boolean | null = null;
    if (tables.has("profile_metadata")) {
      const row = database.prepare("SELECT profile_id FROM profile_metadata LIMIT 1").get() as
        | { profile_id: string }
        | undefined;
      profileMatches = row?.profile_id === options.profileId;
    }
    return {
      schemaVersion,
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      migrationRequired: schemaVersion !== CURRENT_SCHEMA_VERSION,
      quickCheck,
      databaseBytes: metadata.size,
      profileMatches,
      counts
    };
  } finally {
    database.close();
  }
}
