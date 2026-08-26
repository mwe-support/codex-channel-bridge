# Message Archive persistence baseline

## Scope

`@codex-channel-bridge/profile-store` is the first Bridge-owned persistence
slice. It stores normalized QQ and WhatsApp message events without copying
Codex Thread or Turn history. The package currently provides provider-event
deduplication, bounded recent-message reads, and literal-token FTS5 search.

This is not the complete Local Hybrid Retrieval implementation. Substring,
fuzzy, structured, recency-fusion, Archive MCP, media, purge, and outbox
behavior remain later slices.

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
- A new empty database initializes Bridge schema version 1.
- An unknown or older schema returns `migration_required`; normal startup does
  not migrate it.
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
their event loop. The current Profile Worker opens and validates the database
only during startup and closes it during drain. A dedicated storage worker will
be added before Channel ingestion is connected to `commitMessage`,
`recentMessages`, or `searchText`.

## Verification

The unit suite creates only temporary Profile directories and verifies WAL,
owner-only file mode, persistent reopen, deduplication, recent ordering, FTS5,
Profile mismatch, explicit migration refusal, and symlink refusal:

```sh
npm test
```

Platform acceptance must run this suite on the local macOS host, native Linux
on `marvel-mini-pc`, and Linux Docker on that same remote host.

`better-sqlite3` may compile from source when a matching prebuilt binary is not
available. The Linux Docker build stage therefore needs Python 3, `make`, and a
C++ compiler. These tools belong in a future multi-stage build image and must
not enlarge the final runtime image.
