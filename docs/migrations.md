# Explicit Profile schema migration

Normal Supervisor startup never changes an existing Profile database schema.
An older database keeps only that Profile `unavailable: migration_required`;
the Supervisor and sibling Profiles remain live.

Release `0.2.0-rc.1` supports Bridge Profile schema version 10 to version 11 and
composed version 3 through 9 to version 11 paths.
Unknown versions and inconsistent
schema shapes fail closed. Version 3 to 4 adds and backfills durable QQ passive
reply sequences. Version 4 to 5 retains the provider conversation target in the
Message Archive and generalizes Logical Result source identity so restart
uncertainty and its Channel notification can commit atomically. Version 5 to 6
adds the Approval Request source kind, durable Approval lifecycle state, and
body-free Audit Records. Version 6 to 7 adds one session-aware Channel transport
checkpoint per Channel Account so QQ Gateway Resume advances only after the
Message Archive commit. Its sequence is monotonic within one Gateway Session;
a confirmed new Session replaces the old Session and may restart the provider
sequence. Version 7 to 8 adds durable WhatsApp quoted-reply participant and
original-text fields to the Outbox; existing records remain valid without a
quote. Version 8 to 9 creates durable Archive attachment metadata and media
state without fetching or rewriting historical Channel content. Every path
verifies Profile ownership, the resulting schema, foreign
keys, and SQLite `quick_check`. Version 9 to 10 adds native answer-stream delivery
metadata (provider identity, sequence, frame state and prefix digest), not an
answer transcript. It requires the same explicit snapshot/apply gate below;
an existing deployment must not simply restart into this working tree. Version
10 to 11 adds nullable immutable file metadata to `delivery_outbox`, preserving
old text records and their digests. It does not copy Workspace files during
migration or enable automatic export. See [output attachments](output-files.md).

## Plan

Planning is read-only and is available only through the owner-only host-local
control plane:

```sh
bridge migrate plan --profile alpha
```

The result reports the version span, exact operations, irreversible steps,
source bytes, a conservative additional-disk estimate, a source digest, and a
complete plan digest. The source digest covers the SQLite database and its WAL
when present. A plan expires after five minutes and becomes stale if the
Configuration Revision or SQLite source set changes.

## Snapshot evidence and apply

The Bridge coordinates migration but does not create or upload the operator's
backup. After externally snapshotting the prepared Profile data, create an
owner-only, regular, non-symlink JSON file with exactly this shape, using the
`sourceDigest` returned by the plan:

```json
{
  "schemaVersion": 1,
  "kind": "codex-channel-bridge-profile-snapshot",
  "profileId": "alpha",
  "sourceDigest": "FULL_SOURCE_DIGEST",
  "completedAtMs": 1787792400000
}
```

On macOS and Linux the manifest must belong to the service user and have mode
`0600`. Apply requires both the full plan digest and a separate affirmative
snapshot confirmation:

```sh
bridge migrate apply \
  --profile alpha \
  --backup-manifest /absolute/path/alpha-snapshot-manifest.json \
  --confirm FULL_PLAN_DIGEST \
  --snapshot-confirmed yes
```

The Profile must already be disabled/stopped or unavailable specifically with
`migration_required`. The Supervisor serializes maintenance, stops the affected
worker, rechecks the source and manifest, runs one SQLite transaction, verifies
the result, and restarts that Profile when it remains enabled. It does not stop
or roll back sibling Profiles.

Migration emits body-free `started`, `succeeded`, or `failed` records to the
owner-only Profile-local `migration-audit.jsonl`. Records contain only an
internal correlation ID, Profile ID, action, result, version span, and time.
They contain no message bodies, provider identities, credentials, Codex data,
Workspace contents, or paths.

There is no automatic down migration. Rollback means stopping the new binary,
restoring the operator snapshot, and starting the old binary. The current
command does not migrate Codex home, Codex history, Workspace files, Channel
authentication, or any other Codex-owned state.
