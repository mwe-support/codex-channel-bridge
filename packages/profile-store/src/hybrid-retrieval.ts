import type Database from "better-sqlite3";

import type { ChannelConversationKind, ChannelProvider } from "@codex-channel-bridge/core";

import { ProfileStoreError, type ArchiveHybridSearch, type ArchiveHybridSearchHit } from "./profile-store.js";

const MAX_QUERY_BYTES = 8 * 1024;
const MAX_RESULT_LIMIT = 100;
const CANDIDATE_LIMIT = 1_000;
const RRF_K = 60;

interface HybridArchiveRow {
  readonly record_id: string;
  readonly profile_id: string;
  readonly provider: ChannelProvider;
  readonly channel_account_id: string;
  readonly channel_account_epoch_id: string;
  readonly provider_event_id: string;
  readonly conversation_key: string;
  readonly conversation_kind: ChannelConversationKind;
  readonly provider_conversation_id: string;
  readonly provider_identity: string;
  readonly observed_at_ms: number;
  readonly text_body: string | null;
  readonly lexical_rank?: number;
}

interface RankedCandidate {
  readonly row: HybridArchiveRow;
  readonly similarity?: number;
}

const SIGNAL_WEIGHT = {
  exact: 8,
  lexical: 5,
  substring: 4,
  fuzzy: 3,
  structured: 2,
  recency: 1
} as const;

/**
 * Deep Profile-local retrieval module. One query hides independent exact,
 * FTS5, substring, fuzzy, structured, and recency gathers plus weighted RRF.
 */
export function searchArchiveHybrid(
  database: Database.Database,
  profileId: string,
  query: ArchiveHybridSearch
): readonly ArchiveHybridSearchHit[] {
  const validated = validateQuery(query);
  const where = archiveWhere(validated);
  const parameters = { profileId, ...where.parameters, candidateLimit: CANDIDATE_LIMIT };
  const rows = new Map<string, HybridArchiveRow>();
  const rankings = new Map<string, Map<keyof typeof SIGNAL_WEIGHT, number>>();

  const addRanking = (
    signal: keyof typeof SIGNAL_WEIGHT,
    candidates: readonly RankedCandidate[]
  ): void => {
    candidates.forEach((candidate, index) => {
      rows.set(candidate.row.record_id, candidate.row);
      const record = rankings.get(candidate.row.record_id) ?? new Map();
      if (!record.has(signal)) record.set(signal, index + 1);
      rankings.set(candidate.row.record_id, record);
    });
  };

  const recent = selectRows(
    database,
    `${where.sql} ORDER BY observed_at_ms DESC, row_id DESC LIMIT @candidateLimit`,
    parameters
  ).map((row) => ({ row }));
  addRanking("recency", recent);
  if (where.hasStructuredFilter) addRanking("structured", recent);

  if (validated.text !== undefined) {
    const textParameters = { ...parameters, text: validated.text };
    addRanking(
      "exact",
      selectRows(
        database,
        `${where.sql} AND text_body = @text COLLATE NOCASE
         ORDER BY observed_at_ms DESC, row_id DESC LIMIT @candidateLimit`,
        textParameters
      ).map((row) => ({ row }))
    );
    addRanking(
      "substring",
      selectRows(
        database,
        `${where.sql} AND instr(lower(text_body), lower(@text)) > 0
         ORDER BY length(text_body) ASC, observed_at_ms DESC, row_id DESC LIMIT @candidateLimit`,
        textParameters
      ).map((row) => ({ row }))
    );
    const expression = literalFtsExpression(validated.text);
    addRanking(
      "lexical",
      selectFtsRows(database, where, { ...parameters, expression }).map((row) => ({ row }))
    );

    const fuzzy = recent
      .map(({ row }): RankedCandidate => ({
        row,
        similarity: fuzzySimilarity(validated.text!, row.text_body ?? "")
      }))
      .filter((candidate) => (candidate.similarity ?? 0) >= validated.fuzzyThreshold)
      .sort((left, right) =>
        (right.similarity ?? 0) - (left.similarity ?? 0) ||
        right.row.observed_at_ms - left.row.observed_at_ms
      );
    addRanking("fuzzy", fuzzy);
  }

  return [...rankings.entries()]
    .map(([recordId, signals]) => {
      const row = rows.get(recordId)!;
      const score = [...signals.entries()].reduce(
        (total, [signal, rank]) => total + SIGNAL_WEIGHT[signal] / (RRF_K + rank),
        0
      );
      return {
        ...toArchivedMessage(row),
        score,
        matchedSignals: [...signals.keys()].sort()
      } satisfies ArchiveHybridSearchHit;
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.observedAtMs - left.observedAtMs ||
      left.recordId.localeCompare(right.recordId)
    )
    .slice(0, validated.limit);
}

function selectRows(
  database: Database.Database,
  suffix: string,
  parameters: Record<string, unknown>
): readonly HybridArchiveRow[] {
  return database.prepare(`SELECT * FROM message_archive ${suffix}`).all(parameters) as HybridArchiveRow[];
}

function selectFtsRows(
  database: Database.Database,
  where: ReturnType<typeof archiveWhere>,
  parameters: Record<string, unknown>
): readonly HybridArchiveRow[] {
  const structured = where.sql.replace(/^WHERE /u, "AND message_archive.");
  const qualified = structured.replaceAll(" AND ", " AND message_archive.");
  return database.prepare(
    `SELECT message_archive.*, bm25(message_archive_fts) AS lexical_rank
       FROM message_archive_fts
       JOIN message_archive ON message_archive.row_id = message_archive_fts.rowid
      WHERE message_archive_fts MATCH @expression
        ${qualified}
      ORDER BY lexical_rank ASC, message_archive.observed_at_ms DESC
      LIMIT @candidateLimit`
  ).all(parameters) as HybridArchiveRow[];
}

function archiveWhere(query: ReturnType<typeof validateQuery>): {
  readonly sql: string;
  readonly parameters: Record<string, unknown>;
  readonly hasStructuredFilter: boolean;
} {
  const clauses = ["profile_id = @profileId"];
  const parameters: Record<string, unknown> = {};
  const add = (clause: string, name: string, value: unknown): void => {
    clauses.push(clause);
    parameters[name] = value;
  };
  if (query.provider !== undefined) add("provider = @provider", "provider", query.provider);
  if (query.channelAccountId !== undefined) {
    add("channel_account_id = @channelAccountId", "channelAccountId", query.channelAccountId);
  }
  if (query.conversationKey !== undefined) {
    add("conversation_key = @conversationKey", "conversationKey", query.conversationKey);
  }
  if (query.conversationKind !== undefined) {
    add("conversation_kind = @conversationKind", "conversationKind", query.conversationKind);
  }
  if (query.providerIdentity !== undefined) {
    add("provider_identity = @providerIdentity", "providerIdentity", query.providerIdentity);
  }
  if (query.observedAfterMs !== undefined) {
    add("observed_at_ms >= @observedAfterMs", "observedAfterMs", query.observedAfterMs);
  }
  if (query.observedBeforeMs !== undefined) {
    add("observed_at_ms < @observedBeforeMs", "observedBeforeMs", query.observedBeforeMs);
  }
  return {
    sql: `WHERE ${clauses.join(" AND ")}`,
    parameters,
    hasStructuredFilter: clauses.length > 1
  };
}

function validateQuery(query: ArchiveHybridSearch): ArchiveHybridSearch & {
  readonly limit: number;
  readonly fuzzyThreshold: number;
} {
  const text = query.text?.trim();
  if (text !== undefined && (text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_QUERY_BYTES)) {
    invalidQuery();
  }
  const limit = query.limit ?? 20;
  const fuzzyThreshold = query.fuzzyThreshold ?? 0.34;
  if (
    !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT ||
    !Number.isFinite(fuzzyThreshold) || fuzzyThreshold < 0.1 || fuzzyThreshold > 1 ||
    (query.provider !== undefined && query.provider !== "qq" && query.provider !== "whatsapp") ||
    (query.conversationKind !== undefined && query.conversationKind !== "private" && query.conversationKind !== "group") ||
    !validOptionalIdentifier(query.channelAccountId) ||
    !validOptionalIdentifier(query.conversationKey) ||
    !validOptionalIdentifier(query.providerIdentity) ||
    !validOptionalTimestamp(query.observedAfterMs) ||
    !validOptionalTimestamp(query.observedBeforeMs) ||
    (query.observedAfterMs !== undefined && query.observedBeforeMs !== undefined &&
      query.observedAfterMs >= query.observedBeforeMs)
  ) invalidQuery();
  return { ...query, ...(text === undefined ? {} : { text }), limit, fuzzyThreshold };
}

function literalFtsExpression(text: string): string {
  return text.split(/\s+/u).filter(Boolean).map((token) =>
    `"${token.replaceAll('"', '""')}"`
  ).join(" AND ");
}

function fuzzySimilarity(left: string, right: string): number {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aGrams = grams(a);
  const bGrams = grams(b);
  let overlap = 0;
  const remaining = new Map<string, number>();
  for (const gram of bGrams) remaining.set(gram, (remaining.get(gram) ?? 0) + 1);
  for (const gram of aGrams) {
    const count = remaining.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (aGrams.length + bGrams.length);
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function grams(value: string): readonly string[] {
  const padded = `  ${value}  `;
  const result: string[] = [];
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    result.push(padded.slice(index, index + 3));
  }
  return result;
}

function toArchivedMessage(row: HybridArchiveRow) {
  return {
    recordId: row.record_id,
    profileId: row.profile_id,
    provider: row.provider,
    channelAccountId: row.channel_account_id,
    channelAccountEpochId: row.channel_account_epoch_id,
    providerEventId: row.provider_event_id,
    conversationKey: row.conversation_key,
    conversationKind: row.conversation_kind,
    providerConversationId: row.provider_conversation_id,
    providerIdentity: row.provider_identity,
    observedAtMs: row.observed_at_ms,
    text: row.text_body
  };
}

function validOptionalIdentifier(value: string | undefined): boolean {
  return value === undefined || (value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_QUERY_BYTES);
}

function validOptionalTimestamp(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function invalidQuery(): never {
  throw new ProfileStoreError("invalid_channel_message", "Archive hybrid query is invalid");
}
