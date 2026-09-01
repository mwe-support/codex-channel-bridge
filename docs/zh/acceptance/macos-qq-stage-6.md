# 原生 macOS QQ 验收——阶段六

- 日期：2026-09-01（Asia/Shanghai）
- 候选版本：基于 `e9cfcab` 的阶段六工作树
- Host Target：原生 macOS
- Codex CLI：`0.149.1`，已验证 Stable Schema
- Channel：腾讯官方 QQ Bot，私聊限制为一个 Provider-stable Identity

## 无内容结果

1. 实际 Supervisor、Profile Worker、Profile-local Codex App Server 与官方 QQ
   Adapter 进入 `ready`。已登录的原生 QQ Client 发送一条真实私聊 Message；
   Bridge 完成一个 Codex Turn，Client 显示精确的
   `STAGE6-OPERATIONS-READY` Marker。
2. `bridge doctor` 只读检查 Live Profile，没有改变 Runtime。结果为 `ready`、
   无 Issue、SQLite `quick_check=ok`、Schema Version 9，且可用磁盘容量充足。
3. `backup prepare` 完成有界 Drain 与 Durable Maintenance Hold。Profile 依次从
   `ready` 进入 `draining`、`stopped` 和 `stopped: maintenance_hold`。实际
   Owner-only External Snapshot 复制 Bridge State 与 Codex Home；临时 Codex IPC
   Socket 被排除，因为 Unix Socket 不是持久 Backup Data。
4. 匹配 Hold 存在期间，只读 `restore validate` 返回 `valid=true` 且无 Issue。
   `backup finish` 接受真实 Snapshot Confirmation 与完整 Hold Token，随后同一
   Profile 经 `starting` 返回 `ready`。
5. Support Bundle Plan/Apply CLI 在验收中暴露一个问题：Confirmation Digest
   包含 Plan Expiry，导致第二次确认命令无法匹配。Digest 现在只覆盖稳定的所选
   Scope 与 Output Contract；Focused Regression Assertion 和真实两条 CLI 命令均
   通过。
6. 创建的 Support Bundle 包含三个 Owner-only `0600` File。Content Scan 没有发现
   完整本地 Path、Secret 或 Credential Term、Channel Body、Codex
   Input/Output/Reasoning Field 或 Raw Provider Identity。Audit Query 只返回无内容
   `backup_prepare`、`backup_finish` 和 `support_bundle_create` Action。
7. 对健康 Profile 执行 Manual Circuit Reset 时，以 `circuit_not_open` Fail Closed。
   Unit Coverage 验证实际 Open Circuit 只能通过精确的 Profile-local Reset Path
   释放，且必须重新完成 Capability Negotiation。
8. 运行后的 Database 仍是 Schema Version 9，且 `quick_check=ok`。Durable Total
   为七条 Message Archive Row、一个 Attachment、一个 Thread Binding、六条 Codex
   Input Correlation、六个 Logical Result、六条 Outbox Record、零 Pending Approval
   Request，以及三条 Body-free Audit Record。
9. Supervisor 最后完成 `ready`→`draining`→`stopped` 的 Graceful Transition。
   验证完成后删除临时 External Snapshot 与 Support Bundle，测试目录中不再保留
   Credential 或 Codex-home Copy；原始 Profile Data 保持不变。
10. 完整 Deterministic Suite 以 217/217 通过。Native Host Contract 针对 Codex
    `0.149.1` 也全部通过：Generated-schema Protocol、四个 Owner-only
    Control-plane Socket Case 与 Supervisor Worker-process Contract。

本文不保留 Credential、Secret Reference Name、Raw Provider Identity、Provider
Message ID、Channel Body、Codex Output、Media Content 或本地敏感 Path。本次没有
配对真实 WhatsApp Account。
