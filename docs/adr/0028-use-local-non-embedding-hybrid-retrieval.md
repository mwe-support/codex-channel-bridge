# Use local non-embedding Hybrid Retrieval

Next amendment, accepted 2026-09-05: the signal list below describes the current
implementation, not a permanent algorithm mandate. Compare changes on a fixed
labeled set covering exact matches, Chinese substrings, misspellings, historical
records, structured scope and no-match queries. Report recall/rank, latency,
resource cost and candidate-window limits. Preserve approved behavior unless
the user accepts measured losses. The 2a665ef ablation loses a recent typo target
without fuzzy matching, so retain all current signals in this change. Fuzzy
matching currently checks only the most recent 1,000 filtered candidates;
recency may return unrelated fallback records, distinguished by matched signals.
These limits are not semantic search or complete historical fuzzy coverage.

The first release will keep each Profile's permanent Message Archive in one WAL-mode SQLite database driven by a pinned `better-sqlite3` version with FTS5 required. Local Hybrid Retrieval follows the proven Hermes snapshot-store shape: exact message, value, filename, and digest matches; FTS5 BM25; substring and fuzzy text matches; structured filters; and recency are gathered independently and fused with weighted reciprocal-rank fusion. It does not introduce `sqlite-vec`, a local embedding model, or an external Embedding Provider. This preserves hybrid lexical and fuzzy retrieval without new credentials, content egress, model downloads, or a second inference lifecycle; it must not be described as semantic or vector search.

This retrieval boundary applies only to the Bridge-owned Message Archive. It
must not index a copied Codex transcript, reconstruct a Codex Thread, or perform
context compaction. Codex 0.149.1 already persists Thread history, supports
stable legacy-history reads and experimental literal body search, and owns
automatic and manual context compaction; those mechanisms remain authoritative.
Experimental search and paginated-history methods are optional compatibility
enhancements, not first-release correctness dependencies. The Bridge index
covers Channel facts Codex does not natively own, including
Passive Context Events, provider identifiers and metadata, media archive state,
and delivery records. See
[`../research/codex-native-thread-history-retrieval-and-compaction.md`](../research/codex-native-thread-history-retrieval-and-compaction.md)
for the pinned protocol and implementation evidence.
