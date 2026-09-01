# 阶段 8 macOS WhatsApp 验收

- 日期：2026-09-01
- 候选版本：`1bc2e0e` 加本次验收记录的 WhatsApp 配对修复
- 主机：原生 macOS
- Codex CLI：管理员提供的 `0.149.1`
- Provider Library：`baileys@7.0.0-rc14`

## 真实账号结果

- 配对只通过 owner-only 本地控制 Socket 与宿主机交互式终端发起。QR Value
  未持久化，也未复制到 Repository、Log、Audit Record 或本文档。
- 手机端确认 Linked Device 后，Bridge 原子创建 Active Auth Generation，
  WhatsApp Adapter 进入 `ready`。
- 原生 WhatsApp 客户端发出一条真实私聊入站消息后，Bridge 产生一条 Archive
  Event、一条 Codex Input Correlation、一个 Logical Result 和一条 Provider
  `accepted` 的 Outbox Delivery；客户端可见回复已到达。
- Supervisor 有界停止并重启后，Active Auth Generation 无需再次扫码即可打开，
  Profile 直接恢复为 `ready`。
- 重启后发送的真实 Bridge 本地命令已收到回复，且没有新增 Codex Input
  Correlation，保持了命令所有权边界。
- 测试群内仅看似带 `@`、但未从 Provider 成员候选中选择用户的普通文本只被
  被动归档，没有创建 Codex Input。
- 从成员候选中选择真实 Momo 后，群聊消息分别新增一条 Archive Record、Codex
  Input Correlation、Logical Result 和 Provider `accepted` 的 Outbox Delivery；
  原生客户端可见 Momo 的群聊回复已到达。
- 群聊 Access 仅在本次有界验收中临时开放，验收后已恢复为 `deny`。

## 发现并修复的问题

1. 生产 Profile Path 是 `state/channel-auth/ACCOUNT`，但首次配对创建逻辑假设
   `channel-auth` Parent 已存在。Auth-state Module 现在会先创建并验证该
   owner-only Parent，再创建 Account Root；嵌套路径 Regression Test 覆盖真实
   生产结构。
2. Baileys 7 QR Pairing 会持久化 `creds.me` 和 Signed `account`，但该路径的旧版
   `creds.registered` Field 仍为 false。Bridge 现在按固定 Provider Library 的
   真实 Credential Contract 激活 Staged Generation。Regression Test 保持
   `registered=false`，同时证明成功激活、`restartRequired` 处理和 Account
   Lifecycle Replacement。
3. 不含内容的 `WhatsApp pairing ...` 错误此前在 IPC 中被折叠成通用错误。
   现在只有发起操作的本地 CLI 会收到有界、安全的阶段信息，Raw QR 和 Provider
   Identity 仍不会暴露。
4. Baileys 7 用账号 LID 表示从群成员候选中选中的提及，而 Adapter 此前只比较
   `socket.user.id`。Normalizer 现在同时接受 `id` 与 `lid`；Regression Test
   覆盖 LID Mention，且不放宽 Passive Message 边界。

修复前失败尝试产生的两个 Provider Linked Device 已由账号所有者移除；相应的
Staged Local Generation 均被丢弃，从未成为 Active Generation。

本文档不包含 Channel Body、Codex Output、Raw Provider Identity、Provider
Message ID、QR Value、Credential、Auth State 或敏感本地路径。
