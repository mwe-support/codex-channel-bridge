# 原生 macOS QQ 验收——阶段二

- 日期：2026-08-31（Asia/Shanghai）
- 候选版本：基于 `ad53710` 的阶段二工作树
- Host Target：原生 macOS
- Codex CLI：`0.149.1`，已验证 Stable Schema
- Channel：腾讯官方 QQ Bot，私聊

## 无内容结果

1. App Server Child Environment 排除了外层 Codex Desktop Tool Pipe、Permission Profile、Session Identifier、Channel Credential 与 Deployment-wide API Key，同时保留 Profile Codex home 以及原生 `on-request` 与 `workspace-write` 设置。
2. 宿主 Codex 配置使用原生 `auto_review`，由 Codex 内部解决审批，因此不会产生未解决的 Channel Prompt。为验收未解决审批的 Transport，管理员提供的临时 Executable Wrapper 仅选择 Codex 原生 `user` Reviewer；没有修改宿主配置，也没有增加 Bridge-owned Reviewer Policy。
3. 一次真实的 Workspace 外命令请求先创建一条 Durable Approval Record、一个 Approval Logical Result 和一条 Provider-accepted Approval Outbox Record，随后 QQ Client 显示 Decision Prompt。
4. 刻意发送的错误 Token 使 Approval 保持 Pending。正确 Token 只响应原始 App Server Request；记录变为 `responded/accepted/accept`，命令完成，一个终态 Codex Logical Result 通过 Provider-accepted Outbox 投递。
5. 第二个 Pending Approval 出现后，只终止 Profile 自有 App Server Child。Profile 经历 `unavailable(protocol_fault) → ready`；Approval 变为 `cancelled`，Reason 为 `app_server_generation_lost`，Restart Reconciliation 提交一个 Uncertainty Result。重启后复用旧 Token 没有改变状态，也没有执行命令。
6. 最终 Durable Count 为：两条 Approval Request、两条 Accepted Approval Presentation、一条 Responded Decision、一条 Generation-lost Cancellation、三条 Accepted Outbox Record、一条 Rejected Stale-generation Record，以及四条不含正文的 Approval Audit Record，覆盖 Request、Presentation 与 Resolution。
7. 全新验收部署共归档五条真实 Inbound Event。SIGINT 最终产生有界的 `draining → stopped` 和 `supervisor_stopped` Transition。

本文不保留 Credential、Approval Token、Raw Provider Identity、Provider Message ID、Channel Body、Codex Output 或本地敏感路径。
