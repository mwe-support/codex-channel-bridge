# 显式 Profile Schema Migration

Supervisor 正常启动绝不修改现有 Profile Database Schema。旧 Database 只会让对应
Profile 保持 `unavailable: migration_required`；Supervisor 与 Sibling Profile 继续
保持 Live。

当前 Binary 支持 Bridge Profile Schema 6→7，以及串联的 3、4 或 5→7 Path。未知
Version 或不一致的 Schema Shape 都会失败关闭。3→4 会增加并回填持久 QQ Passive
Reply Sequence；4→5 会在 Message Archive 保留 Provider Conversation Target，并泛化
Logical Result Source Identity，使 Restart Uncertainty 与其 Channel Notification 能在
同一 Transaction 提交；5→6 增加 Approval Request Source Kind、持久 Approval
Lifecycle State 与不含正文的 Audit Record。6→7 为每个 Channel Account 增加一个
Session-aware Channel Transport Checkpoint，使 QQ Gateway Resume 只在 Message Archive
提交后推进。Sequence 在同一个 Gateway Session 内单调递增；确认新的 Session 后会替换
旧 Session，Provider Sequence 可以重新从较小值开始。所有 Path 都会验证 Profile
Ownership、迁移后 Schema、Foreign Key 与 SQLite `quick_check`。

## Plan

Plan 是只读操作，并且只能通过 Owner-only Host-local Control Plane 执行：

```sh
bridge migrate plan --profile alpha
```

结果会报告 Version Span、准确 Operation、Irreversible Step、Source Bytes、保守的新增
磁盘估算、Source Digest 与完整 Plan Digest。存在 WAL 时，Source Digest 同时覆盖 SQLite
Database 与 WAL。Plan 五分钟后过期；Configuration Revision 或 SQLite Source Set 变化也会
使其失效。

## Snapshot Evidence 与 Apply

Bridge 只协调 Migration，不创建或上传 Operator Backup。使用外部工具完成 Prepared Profile
Data Snapshot 后，创建一个 Owner-only、Regular、Non-symlink JSON File，并使用 Plan 返回的
`sourceDigest`。文件必须严格符合以下 Shape：

```json
{
  "schemaVersion": 1,
  "kind": "codex-channel-bridge-profile-snapshot",
  "profileId": "alpha",
  "sourceDigest": "FULL_SOURCE_DIGEST",
  "completedAtMs": 1787792400000
}
```

在 macOS 与 Linux 上，Manifest 必须属于 Service User 且 Mode 为 `0600`。Apply 同时要求
完整 Plan Digest 与单独的 Snapshot Affirmative Confirmation：

```sh
bridge migrate apply \
  --profile alpha \
  --backup-manifest /absolute/path/alpha-snapshot-manifest.json \
  --confirm FULL_PLAN_DIGEST \
  --snapshot-confirmed yes
```

Profile 必须已经 Disabled/Stopped，或明确处于 `unavailable: migration_required`。
Supervisor 会串行化 Maintenance、停止受影响 Worker、重新检查 Source 与 Manifest、执行一个
SQLite Transaction、验证结果，并在该 Profile 仍为 Enabled 时重启它。Sibling Profile 不会
被停止或回滚。

Migration 会把不含内容的 `started`、`succeeded` 或 `failed` Record 写入 Owner-only、
Profile-local 的 `migration-audit.jsonl`。Record 只包含内部 Correlation ID、Profile ID、
Action、Result、Version Span 与时间，不包含 Message Body、Provider Identity、Credential、
Codex Data、Workspace Content 或 Path。

不提供自动 Down Migration。Rollback 表示停止新 Binary、恢复 Operator Snapshot，再启动旧
Binary。当前 Command 不迁移 Codex Home、Codex History、Workspace File、Channel
Authentication 或任何其他 Codex-owned State。
