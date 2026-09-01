# Host-local 运维

首版管理入口是结构化 Host-local Control Plane。CLI 必须使用与前台
Supervisor 相同的 Owner-only Endpoint。这些操作不会安装或升级 Codex，也不会
开放 TCP 或 HTTP Listener。

以下示例假设仓库已经 Build，并使用显式 Endpoint：

```sh
CLI="node packages/cli/dist/main.js"
ENDPOINT="/absolute/path/control.sock"
```

## 只读 Doctor

```sh
$CLI doctor --endpoint "$ENDPOINT"
$CLI doctor --profile alpha --endpoint "$ENDPOINT"
```

`doctor` 检查已接受的 Configuration Shape、Profile Health、Path 类型与权限、可用
磁盘容量、SQLite `quick_check`、Bridge Schema 和无内容 Table Count。它不会修复、
重启、迁移或改变 Runtime State。检查失败时以 Status 2 退出。

## Backup 协调

Backup Byte Copy 始终由 Operator 负责。`prepare` 对所选 Profile 做有界 Drain 并
停止它，确认 Outbox 已静止，Checkpoint SQLite WAL，写入 Owner-only Manifest，
并建立 Durable Maintenance Hold：

```sh
$CLI backup prepare \
  --profile alpha \
  --manifest /owner-only/path/alpha-backup.json \
  --include-workspace no \
  --endpoint "$ENDPOINT"
```

Hold 生效期间，Operator 必须 Snapshot Manifest 中列出的全部 Path。Bridge 不会
Copy、Upload、Parse 或 Repackage 这些 Path。只有外部 Snapshot 确实存在后，才能
释放 Hold：

```sh
$CLI backup finish \
  --profile alpha \
  --manifest /owner-only/path/alpha-backup.json \
  --hold-token COMPLETE_HOLD_TOKEN \
  --snapshot-confirmed yes \
  --endpoint "$ENDPOINT"
```

Hold 在 Supervisor Restart 后仍然存在。Hold 存在期间，Profile 保持 Stopped，且
影响它的 Configuration Change 会被拒绝。Restore Validation 是只读操作，必须在
匹配的 Maintenance Hold 存在时执行：

```sh
$CLI restore validate \
  --profile alpha \
  --manifest /owner-only/path/alpha-backup.json \
  --endpoint "$ENDPOINT"
```

Validation 检查 Profile ID、Operating-system Family、Configured Path、Schema、
SQLite Integrity 与静止 Outbox；它不会 Restore Data 或改写 Codex State。

## Audit Record

查询一个 Profile 或全部已配置 Profile：

```sh
$CLI audit query --profile alpha --limit 100 --endpoint "$ENDPOINT"
```

Export 在显式 Destination 新建 Owner-only File：

```sh
$CLI audit export \
  --profile alpha \
  --limit 500 \
  --destination /owner-only/path/audit.json \
  --endpoint "$ENDPOINT"
```

Retention 是两步 Destructive Workflow。第一条命令只返回精确 Count 和 Digest；
带上两者重复执行，才会应用当前 Plan：

```sh
$CLI audit retain --profile alpha --before-ms 1788105600000 --endpoint "$ENDPOINT"
$CLI audit retain \
  --profile alpha \
  --before-ms 1788105600000 \
  --confirm-count EXACT_COUNT \
  --confirm-digest EXACT_DIGEST \
  --endpoint "$ENDPOINT"
```

Cleanup 会追加一条 Exempt、永久保留、Body-free 的 Audit Record。

## Support Bundle

Support Bundle 创建同样是 Plan/Apply Workflow。第一次调用只报告所选 Profile、
Time Range、Allowlisted Field、Estimated Size 与 Output Path，不创建任何文件：

```sh
$CLI support bundle \
  --profile alpha \
  --from-ms 0 \
  --to-ms 1788105600000 \
  --output /owner-only/path/support-bundle \
  --endpoint "$ENDPOINT"
```

使用返回的完整 Plan Digest 重复调用：

```sh
$CLI support bundle \
  --profile alpha \
  --from-ms 0 \
  --to-ms 1788105600000 \
  --output /owner-only/path/support-bundle \
  --confirm COMPLETE_PLAN_DIGEST \
  --endpoint "$ENDPOINT"
```

新建的 Owner-only Directory 包含无内容 Metadata、Audit Action Summary 与 Digest
Manifest。它排除 Channel Body、Codex Input/Output、Raw Provider Identity、Secret
及 Secret Reference Name、Media、Codex Home/Workspace Content 和完整本地 Path，
并且绝不会自动 Upload。

## 手动重置 Codex Circuit

```sh
$CLI circuit reset --profile alpha --endpoint "$ENDPOINT"
```

Reset 只释放已经因 App Server 有界 Restart Budget 耗尽而打开的 Profile-local
Circuit。它不会绕过 Capability Negotiation，也不会重启健康 Profile。新的 App
Server Generation 仍必须完成正常 Capability Probe，Profile 才能进入 Ready。

## 磁盘安全下限

`supervisor.diskSafetyFloorBytes` 为 Durable Bridge State 保留 Deployment Storage。
低于阈值时，受影响 Profile Fail Closed 为 `unavailable: storage_pressure`，停止
Media Mirroring；如果 Channel Event 无法安全 Commit，还会断开 Channel Adapter。
已 Commit 的 Outbox Delivery 仍是更高优先级 Work。请在 Bridge 外部释放磁盘空间，
然后 Restart 或显式重新 Apply Configuration；Bridge 不会通过自动删除内容来制造
可用空间。
