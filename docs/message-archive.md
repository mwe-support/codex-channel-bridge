# Message Archive persistence baseline

## Scope

`@codex-channel-bridge/profile-store` is the first Bridge-owned persistence
slice. It stores normalized QQ and WhatsApp message events without copying
Codex Thread or Turn history. The package currently provides provider-event
deduplication, bounded recent-message reads, literal-token FTS5 search, and the
atomic Logical Result plus durable Outbox contract described in
[`delivery.md`](delivery.md).

This is not the complete Local Hybrid Retrieval implementation. Substring,
fuzzy, structured, recency-fusion, Archive MCP, media, and purge behavior
remain later slices.

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
- A new empty database initializes Bridge schema version 4.
- An unknown or older schema returns `migration_required`; normal startup does
  not migrate it. The affected Profile reports `migration_required` without
  starting Codex. The explicit host-local migration workflow currently supports
  only the known version 3 to 4 span; see [`migrations.md`](migrations.md).
- The deduplication identity is
  `(Channel Account Epoch ID, provider event ID)`.
- Recent reads return at most 500 records and preserve chronological order
  within the selected recent window.
- FTS5 search treats input as literal whitespace-delimited tokens joined with
  `AND`; it does not expose raw FTS query syntax and is not semantic search.

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
