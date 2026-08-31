# Message Archive persistence baseline

## Scope

`@codex-channel-bridge/profile-store` is the first Bridge-owned persistence
slice. It stores normalized QQ and WhatsApp message events and Channel-owned
attachment facts without copying Codex Thread or Turn history. It provides
provider-event deduplication, bounded reads, local non-embedding Hybrid
Retrieval, a read-only Profile-local Archive MCP, bounded media mirroring,
explicit Archive Purge, and the atomic Logical Result plus durable Outbox
contract described in [`delivery.md`](delivery.md).

## Profile ownership

Every Profile configures one exclusive `stateDirectory`. The directory must not
overlap any Workspace or Codex home owned by any Profile. On macOS and Linux it
must be a real directory owned by the service user with mode `0700`.

The Profile Worker opens `stateDirectory/bridge.sqlite` during startup and
closes it during drain. A new file is set to mode `0600`. An existing symlink,
non-regular file, wrong owner, or broader mode fails the Profile closed with
reason `profile_store_unavailable` before Codex starts.

The database records its owning Profile ID. Opening it for a different Profile
fails with `profile_mismatch`; data is never silently adopted or moved.

## SQLite contract

- `better-sqlite3` is pinned to `13.0.3` and requires Node.js 22 or newer.
- WAL journal mode, foreign keys, `synchronous=FULL`, and FTS5 are required.
- A new empty database initializes Bridge schema version 9.
- An unknown or older schema returns `migration_required`; normal startup does
  not migrate it. The affected Profile reports `migration_required` without
  starting Codex. The explicit host-local migration workflow currently supports
  only the known version 3, 4, 5, 6, 7, or 8 to 9 spans; see [`migrations.md`](migrations.md).
- The deduplication identity is
  `(Channel Account Epoch ID, provider event ID)`.
- Recent reads return at most 500 records and preserve chronological order
  within the selected recent window.
- Hybrid Retrieval fuses exact, BM25/FTS5 lexical, substring, trigram-fuzzy,
  structured-filter, and recency ranks. It is local and deterministic; it does
  not use embeddings, a vector extension, or an external provider.

## Archive MCP

`bridge archive mcp --profile ID --state-directory PATH` starts a read-only
stdio MCP server for one Profile. It exposes bounded `archive_search` and
`archive_recent` tools. The server opens the existing WAL database read-only,
never mutates Codex configuration, and omits raw provider event and participant
identifiers from tool results. An administrator may register this process in a
Profile's Codex-owned MCP configuration; the Bridge does not do so itself.

## Attachments and media

Message and attachment metadata commit in one SQLite transaction before any
byte side effect. QQ defaults to provider metadata and links only. WhatsApp
uses the pinned Baileys media stream after decryption and stores it under
`media/sha256/<prefix>/<digest>`. Profile-local `media` configuration sets
`perAttachmentLimitBytes` and `profileQuotaBytes`; their defaults are 64 MiB
per attachment and 10 GiB of mirrored bytes per Profile. Quota decisions are
serialized within the Profile so concurrent streams cannot oversubscribe the
configured bound. A limit, quota, or stream failure
changes only that attachment to `unavailable`; its metadata remains archived
and the Bridge never reports missing bytes as durable storage. Attachments are
never executed automatically. A Profile-worker generation marks any inherited
`pending` byte operation `unavailable` with `media_source_lost` before adapters
start; a process-bound provider stream is never assumed replayable after a
restart.

## Explicit purge

`bridge archive purge` supports exactly the whole Archive for one Profile or
one exact Conversation before a timestamp. Planning reports the message count,
unique referenced media bytes, live-reference count, and selection digest.
Apply requires both the complete Profile ID and expected count, operates only
while the Profile is disabled/stopped, deletes base and FTS rows transactionally,
reclaims only unreferenced content-addressed media, preserves Thread Bindings
and Codex history, and appends a body-free Audit Record. Physical media cleanup
is best-effort after the database transaction; the result reports a
content-free `mediaCleanupFailures` count so a filesystem fault cannot disguise
an already committed database purge as rollback-safe.

`bridge profile purge` is separate and requires a disabled, quiescent Profile
plus confirmation using the complete Profile ID. It lists Bridge-owned and
preserved paths, deletes only Bridge state and locally held Channel
authentication, preserves Workspace and Codex home, and leaves a permanent
body-free Profile tombstone and audit entry outside the purged directory.

Normalized external identifiers are non-empty and limited to 8 KiB each. A
text body may be null and is limited to 1 MiB of UTF-8. These limits protect the
local persistence interface; provider Adapters may impose tighter limits.

## Event-loop rule

`better-sqlite3` is synchronous. Channel Adapters must not call the store from
their event loop. `ProfileStore` now exposes only asynchronous operations and
runs the synchronous SQLite implementation in one dedicated Node.js Worker
thread per Profile. The Profile Worker opens that storage Worker before Codex.
Its single Inbound Pipeline combines Adapter-owned provider facts with the
Worker-owned Profile, Channel Account, and Account Epoch context, derives the
Conversation Key, commits the normalized event, and exposes only newly inserted
events to later routing work. A storage failure makes the Profile unavailable
and stops its Channel Adapters; it never starts Codex work from an uncommitted
event. An invalid or provider-mismatched Adapter event instead isolates that
Adapter and leaves Codex and sibling Adapters available.

## Verification

The unit suite creates only temporary Profile directories and verifies the
asynchronous Worker seam in addition to WAL, owner-only file mode, persistent
reopen, deduplication, recent ordering, FTS5, Profile mismatch, explicit
migration refusal, and symlink refusal:

```sh
npm test
```

Platform acceptance must run this suite on the local macOS host, native Linux
on `marvel-mini-pc`, and Linux Docker on that same remote host.

`better-sqlite3` may compile from source when a matching prebuilt binary is not
available. The Linux Docker build stage therefore needs Python 3, `make`, and a
C++ compiler. These tools belong in a future multi-stage build image and must
not enlarge the final runtime image.
