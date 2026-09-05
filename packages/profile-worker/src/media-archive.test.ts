import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ArchiveAttachmentRecord,
  SettleArchiveAttachmentInput
} from "@codex-channel-bridge/profile-store";

import { MediaArchive, type MediaArchiveStore } from "./media-archive.js";

class FakeStore implements MediaArchiveStore {
  used = 0;
  records = new Map<string, ArchiveAttachmentRecord>();

  async mirroredMediaBytes(): Promise<number> {
    return this.used;
  }

  async settleArchiveAttachment(input: SettleArchiveAttachmentInput): Promise<ArchiveAttachmentRecord> {
    const current = this.records.get(input.attachmentRecordId)!;
    const updated: ArchiveAttachmentRecord = input.outcome === "mirrored"
      ? {
          ...current,
          bytesState: "mirrored",
          contentSha256: input.contentSha256,
          mirroredSizeBytes: input.mirroredSizeBytes,
          updatedAtMs: input.settledAtMs
        }
      : {
          ...current,
          bytesState: "unavailable",
          failureReason: input.failureReason,
          updatedAtMs: input.settledAtMs
        };
    this.records.set(updated.attachmentRecordId, updated);
    if (input.outcome === "mirrored") this.used += input.mirroredSizeBytes;
    return updated;
  }
}

function pending(overrides: Partial<ArchiveAttachmentRecord> = {}): ArchiveAttachmentRecord {
  return {
    attachmentRecordId: "attachment-1",
    messageRecordId: "message-1",
    providerAttachmentId: "provider-media-1",
    contentType: "application/octet-stream",
    bytesState: "pending",
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides
  };
}

async function temporaryRoot(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-media-test-"));
  await chmod(directory, 0o700);
  context.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("streams and hashes decrypted provider bytes into content-addressed storage", async (context) => {
  const root = await temporaryRoot(context);
  const store = new FakeStore();
  const record = pending();
  store.records.set(record.attachmentRecordId, record);
  let opens = 0;
  const result = await new MediaArchive(store, {
    rootDirectory: root,
    perAttachmentLimitBytes: 10,
    profileQuotaBytes: 20,
    now: () => 2
  }).mirror(record, {
    openStream: async () => {
      opens += 1;
      return (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      })();
    }
  });
  const digest = createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex");
  assert.equal(opens, 1);
  assert.equal(result.bytesState, "mirrored");
  assert.equal(result.contentSha256, digest);
  assert.deepEqual(await readFile(join(root, "sha256", digest.slice(0, 2), digest)), Buffer.from([1, 2, 3]));
});

test("automatic file snapshots share the media quota and serialized admission with inbound media", async (context) => {
  const root = await realpath(await temporaryRoot(context));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(join(workspace, "report.txt"), "123456");
  const store = new FakeStore();
  const archive = new MediaArchive(store, { rootDirectory: join(root, "media"),
    perAttachmentLimitBytes: 10, profileQuotaBytes: 10,
    outputFiles: { workspace, directory: join(root, "outbound"), excludedPaths: [] } });
  const results = await Promise.all([
    archive.prepareOutputFiles("[Report](report.txt)"), archive.prepareOutputFiles("[Report](report.txt)")
  ]);
  assert.ok(results[0]![0]!.file);
  assert.equal(results[1]![0]!.file, undefined);
  const pendingFile = pending({ declaredSizeBytes: 5 });
  store.records.set(pendingFile.attachmentRecordId, pendingFile);
  let opened = false;
  const inbound = await archive.mirror(pendingFile, { openStream: async () => {
    opened = true; return (async function* () { yield Buffer.from("12345"); })();
  } });
  assert.equal(inbound.bytesState, "unavailable");
  assert.equal(opened, false);
});

test("retains metadata while rejecting attachment and Profile quota overruns", async (context) => {
  const root = await temporaryRoot(context);
  const store = new FakeStore();
  const tooLarge = pending({ attachmentRecordId: "attachment-large", declaredSizeBytes: 11 });
  store.records.set(tooLarge.attachmentRecordId, tooLarge);
  const archive = new MediaArchive(store, {
    rootDirectory: root,
    perAttachmentLimitBytes: 10,
    profileQuotaBytes: 12,
    now: () => 2
  });
  const rejected = await archive.mirror(tooLarge, {
    openStream: async () => {
      throw new Error("must not open");
    }
  });
  assert.equal(rejected.bytesState, "unavailable");
  assert.equal(store.records.get(tooLarge.attachmentRecordId)?.failureReason, "attachment_limit");

  store.used = 10;
  const quota = pending({ attachmentRecordId: "attachment-quota", declaredSizeBytes: 3 });
  store.records.set(quota.attachmentRecordId, quota);
  await archive.mirror(quota, { openStream: async () => (async function* () { yield new Uint8Array([1]); })() });
  assert.equal(store.records.get(quota.attachmentRecordId)?.failureReason, "profile_media_quota");
});

test("stops media mirroring before crossing the deployment disk safety floor", async (context) => {
  const root = await temporaryRoot(context);
  const store = new FakeStore();
  const record = pending({ declaredSizeBytes: 5 });
  store.records.set(record.attachmentRecordId, record);
  let opened = false;
  const result = await new MediaArchive(store, {
    rootDirectory: root,
    perAttachmentLimitBytes: 10,
    profileQuotaBytes: 20,
    storageSafetyFloorBytes: 100,
    availableStorageBytes: async () => 104,
    now: () => 2
  }).mirror(record, {
    openStream: async () => {
      opened = true;
      return (async function* () { yield new Uint8Array([1]); })();
    }
  });
  assert.equal(opened, false);
  assert.equal(result.bytesState, "unavailable");
  assert.equal(store.records.get(record.attachmentRecordId)?.failureReason, "storage_pressure");
});

test("serializes quota accounting across concurrent attachment mirrors", async (context) => {
  const root = await temporaryRoot(context);
  const store = new FakeStore();
  const first = pending({ attachmentRecordId: "attachment-first", declaredSizeBytes: 7 });
  const second = pending({ attachmentRecordId: "attachment-second", declaredSizeBytes: 7 });
  store.records.set(first.attachmentRecordId, first);
  store.records.set(second.attachmentRecordId, second);
  const archive = new MediaArchive(store, {
    rootDirectory: root,
    perAttachmentLimitBytes: 8,
    profileQuotaBytes: 10,
    now: () => 2
  });
  const source = {
    openStream: async () => (async function* () {
      await new Promise((resolve) => setImmediate(resolve));
      yield new Uint8Array(7);
    })()
  };
  const results = await Promise.all([
    archive.mirror(first, source),
    archive.mirror(second, source)
  ]);
  assert.deepEqual(results.map((result) => result.bytesState), ["mirrored", "unavailable"]);
  assert.equal(store.used, 7);
  assert.equal(store.records.get(second.attachmentRecordId)?.failureReason, "profile_media_quota");
});

test("does not trust a pre-existing symlink at a content-addressed path", async (context) => {
  if (process.platform === "win32") return;
  const root = await temporaryRoot(context);
  const store = new FakeStore();
  const bytes = new Uint8Array([1, 2, 3]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const contentDirectory = join(root, "sha256", digest.slice(0, 2));
  const outside = join(root, "outside");
  await mkdir(contentDirectory, { recursive: true, mode: 0o700 });
  await writeFile(outside, bytes, { mode: 0o600 });
  await symlink(outside, join(contentDirectory, digest));
  const record = pending({ attachmentRecordId: "attachment-symlink", declaredSizeBytes: 3 });
  store.records.set(record.attachmentRecordId, record);
  const result = await new MediaArchive(store, {
    rootDirectory: root,
    perAttachmentLimitBytes: 10,
    profileQuotaBytes: 20,
    now: () => 2
  }).mirror(record, {
    openStream: async () => (async function* () { yield bytes; })()
  });
  assert.equal(result.bytesState, "unavailable");
  assert.equal(store.records.get(record.attachmentRecordId)?.failureReason, "media_stream_failed");
});
