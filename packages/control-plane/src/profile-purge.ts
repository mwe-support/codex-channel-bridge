import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat,
  unlink
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { ProfileConfiguration } from "@codex-channel-bridge/config";
import { ProfileStore, type ProfilePurgeState } from "@codex-channel-bridge/profile-store";

export interface ProfilePurgePreview {
  readonly profileId: string;
  readonly state: ProfilePurgeState;
  readonly bridgeOwnedPaths: readonly string[];
  readonly preservedPaths: readonly string[];
  readonly tombstonePath: string;
  readonly selectionDigest: string;
}

export interface ApplyProfilePurgeInput {
  readonly profile: Readonly<ProfileConfiguration>;
  readonly expectedSelectionDigest: string;
  readonly confirmedProfileId: string;
  readonly nowMs: number;
}

export interface ProfilePurgeResult extends ProfilePurgePreview {
  readonly purgedAtMs: number;
  readonly auditRecordId: string;
}

export async function planProfilePurge(
  profile: Readonly<ProfileConfiguration>
): Promise<ProfilePurgePreview> {
  if (profile.enabled) throw new Error("Profile must be disabled before purge");
  const tombstonePath = profileTombstonePath(profile);
  if (await pathExists(tombstonePath)) throw new Error("Profile ID has already been purged");
  await requireOwnerDirectory(profile.stateDirectory);
  const databasePath = join(profile.stateDirectory, "bridge.sqlite");
  const store = await ProfileStore.open({ profileId: profile.id, databasePath });
  let state: ProfilePurgeState;
  try {
    state = await store.profilePurgeState();
  } finally {
    await store.close();
  }
  const externalSecret = !isWithin(profile.stateDirectory, profile.secretsFile)
    ? profile.secretsFile
    : undefined;
  if (externalSecret !== undefined) {
    if (isWithin(profile.workspace, externalSecret) || isWithin(profile.codexHome, externalSecret)) {
      throw new Error("External secretsFile overlaps a preserved Codex-owned path");
    }
    await requireOwnerFile(externalSecret);
  }
  const bridgeOwnedPaths = [profile.stateDirectory, ...(externalSecret ? [externalSecret] : [])];
  const preservedPaths = [profile.workspace, profile.codexHome];
  const database = await stat(databasePath);
  const structural = {
    profileId: profile.id,
    state,
    bridgeOwnedPaths,
    preservedPaths,
    databaseBytes: database.size,
    databaseModifiedMs: database.mtimeMs
  };
  return {
    profileId: profile.id,
    state,
    bridgeOwnedPaths,
    preservedPaths,
    tombstonePath,
    selectionDigest: createHash("sha256").update(JSON.stringify(structural)).digest("hex")
  };
}

export async function applyProfilePurge(input: ApplyProfilePurgeInput): Promise<ProfilePurgeResult> {
  if (input.confirmedProfileId !== input.profile.id) {
    throw new Error("Profile purge confirmation did not match the complete Profile ID");
  }
  const preview = await planProfilePurge(input.profile);
  if (preview.selectionDigest !== input.expectedSelectionDigest) {
    throw new Error("Profile purge selection changed after planning");
  }
  if (preview.state.liveWorkCount !== 0) throw new Error("Profile still has live work");
  const startedAuditRecordId = randomUUID();
  const tombstoneBase = {
    schemaVersion: 1,
    kind: "codex-channel-bridge-profile-tombstone",
    profileId: preview.profileId,
    purgedAtMs: input.nowMs,
    recordCounts: preview.state,
    selectionDigest: preview.selectionDigest,
    workspacePreserved: true,
    codexHomePreserved: true
  };
  await writeOwnerOnlyAtomic(
    preview.tombstonePath,
    `${JSON.stringify({ ...tombstoneBase, result: "started", auditRecordId: startedAuditRecordId })}\n`
  );
  await appendOwnerOnly(
    join(dirname(preview.tombstonePath), "audit.jsonl"),
    `${JSON.stringify({
      auditRecordId: startedAuditRecordId,
      profileId: preview.profileId,
      action: "profile_purge",
      result: "started",
      targetReference: preview.selectionDigest,
      atMs: input.nowMs
    })}\n`
  );
  try {
    const externalSecret = preview.bridgeOwnedPaths.find((path) => path !== input.profile.stateDirectory);
    if (externalSecret) await unlink(externalSecret);
    await rm(input.profile.stateDirectory, { recursive: true, force: false });
    const auditRecordId = randomUUID();
    await writeOwnerOnlyAtomic(
      preview.tombstonePath,
      `${JSON.stringify({ ...tombstoneBase, result: "succeeded", auditRecordId })}\n`
    );
    await appendOwnerOnly(
      join(dirname(preview.tombstonePath), "audit.jsonl"),
      `${JSON.stringify({
        auditRecordId,
        profileId: preview.profileId,
        action: "profile_purge",
        result: "succeeded",
        targetReference: preview.selectionDigest,
        atMs: input.nowMs
      })}\n`
    );
    return { ...preview, purgedAtMs: input.nowMs, auditRecordId };
  } catch (error) {
    const auditRecordId = randomUUID();
    await writeOwnerOnlyAtomic(
      preview.tombstonePath,
      `${JSON.stringify({ ...tombstoneBase, result: "failed", auditRecordId })}\n`
    );
    await appendOwnerOnly(
      join(dirname(preview.tombstonePath), "audit.jsonl"),
      `${JSON.stringify({
        auditRecordId,
        profileId: preview.profileId,
        action: "profile_purge",
        result: "failed",
        targetReference: preview.selectionDigest,
        atMs: input.nowMs
      })}\n`
    );
    throw error;
  }
}

function profileTombstonePath(profile: Readonly<ProfileConfiguration>): string {
  return join(dirname(profile.stateDirectory), ".bridge-profile-tombstones", `${profile.id}.json`);
}

async function writeOwnerOnlyAtomic(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await requireOwnerDirectory(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function appendOwnerOnly(path: string, contents: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "ax", 0o600);
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

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function requireOwnerDirectory(path: string): Promise<void> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("Profile purge directory is insecure");
  if (
    process.platform !== "win32" &&
    (value.uid !== process.getuid?.() || (value.mode & 0o777) !== 0o700)
  ) throw new Error("Profile purge directory is not owner-only");
}

async function requireOwnerFile(path: string): Promise<void> {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink()) throw new Error("Profile purge secret file is insecure");
  if (
    process.platform !== "win32" &&
    (value.uid !== process.getuid?.() || (value.mode & 0o777) !== 0o600)
  ) throw new Error("Profile purge secret file is not owner-only");
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
