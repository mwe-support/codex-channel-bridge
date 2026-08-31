# 原生 macOS QQ 验收——阶段五

- 日期：2026-08-31（Asia/Shanghai）
- 候选版本：基于 `80bbfa3` 的阶段五工作树
- Host Target：原生 macOS
- Codex CLI：`0.149.1`，已验证 Stable Schema
- Channel：腾讯官方 QQ Bot，私聊限制为一个 Provider-stable Identity

## 无内容结果

1. 使用旧 Schema Version 8 State 启动实际 Supervisor 时，Profile 以
   `migration_required` 失败关闭。只有在 Owner-only SQLite Snapshot 与匹配的
   Snapshot Manifest 已存在后，才确认显式 8→9 Migration Plan。Migration 在该
   Profile 内独立完成；普通 Service Start 没有执行 Migration。
2. 随后实际 Supervisor、Profile Worker、Profile-local Codex App Server 与官方
   QQ Adapter 进入 `ready`。从已登录的原生 QQ Client 发送真实私聊 Message 后，
   一个 Codex Turn 完成，并显示完全符合预期的阶段 Marker。Supervisor 完成
   `ready`→`draining`→`stopped` 的 Graceful Transition，再从同一 State 重启；
   第二条真实私聊 Message 显示独立的预期 Restart Marker。
3. Profile-local Archive MCP 通过 stdio 运行，只暴露只读的 `archive_search` 与
   `archive_recent` Tool。真实有界 Query 返回 Archive Result，但不包含 Provider
   Event Identifier 或 Provider Identity；它没有修改 Profile 或 Codex
   Configuration。
4. Host-local Archive Purge Plan 报告了精确的整 Profile Message Count、零 Live
   Reference、Referenced Media Byte 与所需 Confirmation Field。没有对真实验收
   Profile 执行 Destructive Purge Apply。
5. 已登录的 QQ Client 把仓库公开的 Apache-2.0 `LICENSE` 文件发送给测试 Bot，
   QQ 可见确认发送成功。Bridge 新增一条 Message Archive Row 和一条状态为
   `metadata_only` 的 Attachment Row，镜像 Byte 为零，且 Attachment-only Event
   没有启动 Codex Turn。这验证了当前官方 QQ Contract 使用 Metadata/Link
   Persistence，而非 Byte Mirroring。
6. 该检查点的 Schema Version 为 9。Durable Count 为五条 Message Archive Row、一条
   Metadata-only Attachment、四条 Codex Input Correlation、四个 Logical Result、
   四条 Provider-accepted Outbox Record，以及零 Pending Delivery。Supervisor 再次
   完成 Graceful Drain 与 Stop。
7. 完整 Deterministic Suite 以 204/204 通过，覆盖本地 Hybrid Retrieval、只读
   Archive MCP Projection、Transactional Attachment Metadata、串行化的 Profile
   Media Quota Accounting、Archive Purge、Profile Purge Tombstone、Schema
   Migration、QQ Metadata Mapping 与 Baileys Decrypted-stream Handling。本次没有
   配对真实 WhatsApp Account。
8. Native Host Contract 针对 Codex `0.149.1` 全部通过：Generated-schema
   Protocol Contract、四个 Owner-only Control-plane Socket Case 与 Supervisor
   Worker-process Contract 均成功退出。
9. 在最终 Media Path、Restart Reconciliation、Purge State 与 Configuration
   Boundary Hardening 修改之后，再次部署实际当前工作树。Profile 进入 `ready`；
   额外一条真实 QQ 私聊 Message 显示完全符合预期的最终 Marker，且 Shutdown 再次
   经过 `draining` 与 `stopped`。Hardening 后 Durable Total 为六条 Archive Row、
   一条 Metadata-only Attachment、五条 Correlation、五个 Logical Result、五条
   Accepted Outbox Record，以及零 Pending Delivery。

本文不保留 Credential、Raw Provider Identity、Provider Message ID、Channel
Body、Codex Output、Attachment Content、SDK Authentication State 或本地敏感路径。
