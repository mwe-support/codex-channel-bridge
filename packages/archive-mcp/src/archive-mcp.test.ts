import assert from "node:assert/strict";
import test from "node:test";

import type {
  ArchiveHybridSearch,
  ArchiveHybridSearchHit,
  ArchivedChannelMessage
} from "@codex-channel-bridge/profile-store";

import { recentArchive, searchArchive, type ArchiveReader } from "./index.js";

const record: ArchiveHybridSearchHit = {
  recordId: "record-1",
  profileId: "alpha",
  provider: "qq",
  channelAccountId: "qq-primary",
  channelAccountEpochId: "epoch-1",
  providerEventId: "provider-event-sensitive",
  conversationKey: "qq:qq-primary:private:conversation",
  conversationKind: "private",
  providerConversationId: "conversation-sensitive",
  providerIdentity: "participant-sensitive",
  observedAtMs: 1_000,
  text: "archived Channel text",
  score: 1,
  matchedSignals: ["exact", "recency"]
};

test("projects Profile-local Archive tools without returning raw provider identifiers", async () => {
  let query: ArchiveHybridSearch | undefined;
  const reader: ArchiveReader = {
    searchHybrid: async (value) => {
      query = value;
      return [record];
    },
    recentMessages: async () => [record satisfies ArchivedChannelMessage],
    close: async () => undefined
  };
  const searched = await searchArchive(reader, { text: "archived", provider: "qq", limit: 5 });
  assert.deepEqual(query, { text: "archived", provider: "qq", limit: 5 });
  assert.equal(searched.results[0]?.text, "archived Channel text");
  assert.equal("providerIdentity" in searched.results[0]!, false);
  assert.equal("providerEventId" in searched.results[0]!, false);
  assert.deepEqual(searched.results[0]?.matchedSignals, ["exact", "recency"]);

  const recent = await recentArchive(reader, {
    conversationKey: "qq:qq-primary:private:conversation",
    limit: 1
  });
  assert.equal(recent.results.length, 1);
  assert.equal(recent.results[0]?.score, 1);
});
