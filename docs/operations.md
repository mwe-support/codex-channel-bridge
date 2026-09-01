# Host-local operations

The first-release administration surface is the structured host-local control
plane. The CLI must use the same owner-only endpoint as the foreground
Supervisor. These operations never install or upgrade Codex, and none of them
opens a TCP or HTTP listener.

The examples below assume the repository has been built and use an explicit
endpoint:

```sh
CLI="node packages/cli/dist/main.js"
ENDPOINT="/absolute/path/control.sock"
```

## Read-only doctor

```sh
$CLI doctor --endpoint "$ENDPOINT"
$CLI doctor --profile alpha --endpoint "$ENDPOINT"
```

`doctor` checks the accepted configuration shape, Profile health, path type and
permissions, available disk capacity, SQLite `quick_check`, Bridge schema, and
content-free table counts. It does not repair, restart, migrate, or otherwise
change runtime state. A failed check exits with status 2.

## Backup coordination

Backup byte copying remains operator-owned. `prepare` bounded-drains and stops
the selected Profile, verifies that the Outbox is quiescent, checkpoints its
SQLite WAL, writes an owner-only manifest, and installs a durable maintenance
hold:

```sh
$CLI backup prepare \
  --profile alpha \
  --manifest /owner-only/path/alpha-backup.json \
  --include-workspace no \
  --endpoint "$ENDPOINT"
```

The operator must snapshot every path listed in the manifest while the hold is
active. The Bridge does not copy, upload, parse, or repackage those paths. Only
after the external snapshot really exists should the operator release the
hold:

```sh
$CLI backup finish \
  --profile alpha \
  --manifest /owner-only/path/alpha-backup.json \
  --hold-token COMPLETE_HOLD_TOKEN \
  --snapshot-confirmed yes \
  --endpoint "$ENDPOINT"
```

The hold survives a Supervisor restart. While it exists, the Profile remains
stopped and configuration changes affecting it are rejected. Restore
validation is read-only and must run while the matching maintenance hold is
present:

```sh
$CLI restore validate \
  --profile alpha \
  --manifest /owner-only/path/alpha-backup.json \
  --endpoint "$ENDPOINT"
```

Validation checks the Profile ID, operating-system family, configured paths,
schema, SQLite integrity, and quiescent Outbox. It does not restore data or
rewrite Codex state.

## Audit records

Query one Profile or all configured Profiles:

```sh
$CLI audit query --profile alpha --limit 100 --endpoint "$ENDPOINT"
```

Export writes a new owner-only file at an explicit destination:

```sh
$CLI audit export \
  --profile alpha \
  --limit 500 \
  --destination /owner-only/path/audit.json \
  --endpoint "$ENDPOINT"
```

Retention is a two-step destructive workflow. The first command only returns
the exact count and digest. Repeat it with both values to apply the current
plan:

```sh
$CLI audit retain --profile alpha --before-ms 1788105600000 --endpoint "$ENDPOINT"
$CLI audit retain \
  --profile alpha \
  --before-ms 1788105600000 \
  --confirm-count EXACT_COUNT \
  --confirm-digest EXACT_DIGEST \
  --endpoint "$ENDPOINT"
```

The cleanup appends an exempt, permanently retained, body-free Audit Record.

## Support Bundle

Support Bundle creation is also a plan/apply workflow. The first call reports
the selected Profiles, time range, allowlisted fields, estimated size, and
output path without creating anything:

```sh
$CLI support bundle \
  --profile alpha \
  --from-ms 0 \
  --to-ms 1788105600000 \
  --output /owner-only/path/support-bundle \
  --endpoint "$ENDPOINT"
```

Repeat the call with the returned complete plan digest:

```sh
$CLI support bundle \
  --profile alpha \
  --from-ms 0 \
  --to-ms 1788105600000 \
  --output /owner-only/path/support-bundle \
  --confirm COMPLETE_PLAN_DIGEST \
  --endpoint "$ENDPOINT"
```

The new owner-only directory contains content-free metadata, an Audit action
summary, and a digest manifest. It excludes Channel bodies, Codex input and
output, raw provider identities, secrets and Secret Reference names, media,
Codex home and Workspace content, and complete local paths. It is never
uploaded automatically.

## Manual Codex circuit reset

```sh
$CLI circuit reset --profile alpha --endpoint "$ENDPOINT"
```

Reset releases only a Profile-local circuit already opened after the bounded
App Server restart budget was exhausted. It does not bypass capability
negotiation or restart a healthy Profile. A new App Server generation must
still pass the normal capability probe before the Profile becomes ready.

## Disk safety floor

`supervisor.diskSafetyFloorBytes` reserves deployment storage for durable
Bridge state. Below the configured floor the affected Profile fails closed as
`unavailable: storage_pressure`, stops media mirroring, and disconnects Channel
adapters when a Channel event cannot be committed safely. Existing committed
Outbox delivery remains higher-priority work. Recover storage externally, then
restart or explicitly reapply the configuration; the Bridge never deletes
content automatically to manufacture free space.
