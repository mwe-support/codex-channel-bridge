import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import {
  ProfileStore,
  type ArchiveHybridSearch,
  type ArchiveHybridSearchHit,
  type ArchivedChannelMessage
} from "@codex-channel-bridge/profile-store";

export interface ArchiveReader {
  searchHybrid(query: ArchiveHybridSearch): Promise<readonly ArchiveHybridSearchHit[]>;
  recentMessages(
    conversationKey: string,
    limit?: number
  ): Promise<readonly ArchivedChannelMessage[]>;
  close(): Promise<void>;
}

export interface ArchiveSearchToolInput extends ArchiveHybridSearch {}

export interface ArchiveRecentToolInput {
  readonly conversationKey: string;
  readonly limit?: number;
}

export interface ArchiveToolRecord {
  readonly recordId: string;
  readonly provider: "qq" | "whatsapp";
  readonly channelAccountId: string;
  readonly conversationKey: string;
  readonly conversationKind: "private" | "group";
  readonly observedAtMs: number;
  readonly text: string | null;
  readonly score?: number;
  readonly matchedSignals?: readonly string[];
}

export async function searchArchive(reader: ArchiveReader, input: ArchiveSearchToolInput) {
  return { results: (await reader.searchHybrid(input)).map(projectRecord) };
}

export async function recentArchive(reader: ArchiveReader, input: ArchiveRecentToolInput) {
  return {
    results: (await reader.recentMessages(input.conversationKey, input.limit)).map(projectRecord)
  };
}

export function createArchiveMcpServer(reader: ArchiveReader): McpServer {
  const server = new McpServer({ name: "codex-channel-bridge-archive", version: "0.1.0-dev" });

  server.registerTool(
    "archive_search",
    {
      description: "Search only this Codex Profile's Bridge-owned Channel Message Archive using local non-embedding hybrid retrieval.",
      inputSchema: {
        text: z.string().min(1).max(8_192).optional(),
        provider: z.enum(["qq", "whatsapp"]).optional(),
        channelAccountId: z.string().min(1).max(8_192).optional(),
        conversationKey: z.string().min(1).max(8_192).optional(),
        conversationKind: z.enum(["private", "group"]).optional(),
        providerIdentity: z.string().min(1).max(8_192).optional(),
        observedAfterMs: z.number().int().nonnegative().optional(),
        observedBeforeMs: z.number().int().nonnegative().optional(),
        fuzzyThreshold: z.number().min(0.1).max(1).optional(),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async (input) => toolResult(await searchArchive(reader, input))
  );

  server.registerTool(
    "archive_recent",
    {
      description: "Read a bounded chronological window from one exact Channel Conversation in this Profile's Bridge-owned Archive.",
      inputSchema: {
        conversationKey: z.string().min(1).max(8_192),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async (input) => toolResult(await recentArchive(reader, input))
  );
  return server;
}

export async function runArchiveMcp(options: {
  readonly profileId: string;
  readonly stateDirectory: string;
}): Promise<void> {
  const reader = await ProfileStore.open({
    profileId: options.profileId,
    databasePath: join(options.stateDirectory, "bridge.sqlite"),
    readOnly: true
  });
  const server = createArchiveMcpServer(reader);
  const transport = new StdioServerTransport();
  const close = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    await reader.close().catch(() => undefined);
  };
  transport.onclose = () => void close();
  try {
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
}

function toolResult(structuredContent: { readonly results: readonly ArchiveToolRecord[] }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}

function projectRecord(
  record: ArchivedChannelMessage | ArchiveHybridSearchHit
): ArchiveToolRecord {
  return {
    recordId: record.recordId,
    provider: record.provider,
    channelAccountId: record.channelAccountId,
    conversationKey: record.conversationKey,
    conversationKind: record.conversationKind,
    observedAtMs: record.observedAtMs,
    text: record.text,
    ...(isHybridHit(record)
      ? { score: record.score, matchedSignals: record.matchedSignals }
      : {})
  };
}

function isHybridHit(
  record: ArchivedChannelMessage | ArchiveHybridSearchHit
): record is ArchiveHybridSearchHit {
  return "score" in record && "matchedSignals" in record;
}
