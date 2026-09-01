import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  ProviderAttachmentContentSource,
  InboundChannelAttachment
} from "@codex-channel-bridge/core";
import type {
  ArchiveAttachmentRecord,
  SettleArchiveAttachmentInput
} from "@codex-channel-bridge/profile-store";

export interface MediaArchiveStore {
  mirroredMediaBytes(): Promise<number>;
  settleArchiveAttachment(input: SettleArchiveAttachmentInput): Promise<ArchiveAttachmentRecord>;
}

export interface MediaArchiveOptions {
  readonly rootDirectory: string;
  readonly perAttachmentLimitBytes?: number;
  readonly profileQuotaBytes?: number;
  readonly now?: () => number;
  readonly storageSafetyFloorBytes?: number;
  readonly availableStorageBytes?: () => Promise<number>;
}

export class MediaArchive {
  readonly #rootDirectory: string;
  readonly #store: MediaArchiveStore;
  readonly #perAttachmentLimitBytes: number;
  readonly #profileQuotaBytes: number;
  readonly #now: () => number;
  readonly #storageSafetyFloorBytes?: number;
  readonly #availableStorageBytes?: () => Promise<number>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(store: MediaArchiveStore, options: MediaArchiveOptions) {
    this.#store = store;
    this.#rootDirectory = options.rootDirectory;
    this.#perAttachmentLimitBytes = options.perAttachmentLimitBytes ?? 64 * 1024 * 1024;
    this.#profileQuotaBytes = options.profileQuotaBytes ?? 10 * 1024 * 1024 * 1024;
    this.#now = options.now ?? Date.now;
    this.#storageSafetyFloorBytes = options.storageSafetyFloorBytes;
    this.#availableStorageBytes = options.availableStorageBytes;
  }

  public async mirror(
    attachment: ArchiveAttachmentRecord,
    source: ProviderAttachmentContentSource
  ): Promise<InboundChannelAttachment> {
    const operation = this.#tail.then(() => this.#mirror(attachment, source));
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #mirror(
    attachment: ArchiveAttachmentRecord,
    source: ProviderAttachmentContentSource
  ): Promise<InboundChannelAttachment> {
    if (attachment.bytesState !== "pending") return toInboundAttachment(attachment);
    if (
      attachment.declaredSizeBytes !== undefined &&
      attachment.declaredSizeBytes > this.#perAttachmentLimitBytes
    ) {
      return toInboundAttachment(await this.#unavailable(attachment, "attachment_limit"));
    }

    const usedBytes = await this.#store.mirroredMediaBytes();
    if (
      attachment.declaredSizeBytes !== undefined &&
      usedBytes + attachment.declaredSizeBytes > this.#profileQuotaBytes
    ) {
      return toInboundAttachment(await this.#unavailable(attachment, "profile_media_quota"));
    }
    if (this.#storageSafetyFloorBytes !== undefined && this.#availableStorageBytes) {
      const reserve = attachment.declaredSizeBytes ?? this.#perAttachmentLimitBytes;
      const available = await this.#availableStorageBytes().catch(() => 0);
      if (available < this.#storageSafetyFloorBytes + reserve) {
        return toInboundAttachment(await this.#unavailable(attachment, "storage_pressure"));
      }
    }

    const temporaryDirectory = join(this.#rootDirectory, ".tmp");
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    await requireOwnerDirectory(this.#rootDirectory);
    await requireOwnerDirectory(temporaryDirectory);
    const temporaryPath = join(temporaryDirectory, randomUUID());
    const handle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      const stream = await source.openStream();
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw new Error("invalid_media_chunk");
        size += chunk.byteLength;
        if (size > this.#perAttachmentLimitBytes) throw new MediaLimitError("attachment_limit");
        if (usedBytes + size > this.#profileQuotaBytes) throw new MediaLimitError("profile_media_quota");
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      const digest = hash.digest("hex");
      const contentDirectory = join(this.#rootDirectory, "sha256", digest.slice(0, 2));
      const contentPath = join(contentDirectory, digest);
      await mkdir(contentDirectory, { recursive: true, mode: 0o700 });
      await requireOwnerDirectory(join(this.#rootDirectory, "sha256"));
      await requireOwnerDirectory(contentDirectory);
      try {
        await link(temporaryPath, contentPath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await requireMatchingContent(contentPath, digest, size);
      }
      await unlink(temporaryPath);
      return toInboundAttachment(await this.#store.settleArchiveAttachment({
        attachmentRecordId: attachment.attachmentRecordId,
        outcome: "mirrored",
        contentSha256: digest,
        mirroredSizeBytes: size,
        settledAtMs: this.#now()
      }));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      const reason = error instanceof MediaLimitError ? error.reason : "media_stream_failed";
      return toInboundAttachment(await this.#unavailable(attachment, reason));
    }
  }

  async #unavailable(
    attachment: ArchiveAttachmentRecord,
    failureReason: string
  ): Promise<ArchiveAttachmentRecord> {
    return this.#store.settleArchiveAttachment({
      attachmentRecordId: attachment.attachmentRecordId,
      outcome: "unavailable",
      failureReason,
      settledAtMs: this.#now()
    });
  }
}

class MediaLimitError extends Error {
  public constructor(public readonly reason: "attachment_limit" | "profile_media_quota") {
    super(reason);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function requireOwnerDirectory(path: string): Promise<void> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("insecure_media_directory");
  if (
    process.platform !== "win32" &&
    (value.uid !== process.getuid?.() || (value.mode & 0o777) !== 0o700)
  ) throw new Error("insecure_media_directory");
}

async function requireMatchingContent(
  path: string,
  expectedDigest: string,
  expectedSize: number
): Promise<void> {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.size !== expectedSize) {
    throw new Error("invalid_existing_media");
  }
  if (
    process.platform !== "win32" &&
    (value.uid !== process.getuid?.() || (value.mode & 0o777) !== 0o600)
  ) throw new Error("invalid_existing_media");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.byteLength;
    hash.update(chunk);
  }
  if (size !== expectedSize || hash.digest("hex") !== expectedDigest) {
    throw new Error("invalid_existing_media");
  }
}

export function toInboundAttachment(record: ArchiveAttachmentRecord): InboundChannelAttachment {
  return {
    attachmentRecordId: record.attachmentRecordId,
    providerAttachmentId: record.providerAttachmentId,
    contentType: record.contentType,
    ...(record.filename === undefined ? {} : { filename: record.filename }),
    ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
    ...(record.declaredSizeBytes === undefined ? {} : { declaredSizeBytes: record.declaredSizeBytes }),
    ...(record.width === undefined ? {} : { width: record.width }),
    ...(record.height === undefined ? {} : { height: record.height }),
    ...(record.transcript === undefined ? {} : { transcript: record.transcript }),
    bytesState: record.bytesState,
    ...(record.contentSha256 === undefined ? {} : { contentSha256: record.contentSha256 }),
    ...(record.mirroredSizeBytes === undefined ? {} : { mirroredSizeBytes: record.mirroredSizeBytes })
  };
}
