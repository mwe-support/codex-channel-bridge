# Thread Binding 与 Codex 输入关联

## 所有权

Bridge 只存储 Channel Conversation Scope 到 Codex Thread ID 的当前映射。Codex 仍然是 Thread、Turn、History、Setting 与 Compaction 的权威来源；Bridge 不复制这些内容。

稳定的 App Server Contract 区分新建与载入已有 Thread：`thread/start` 创建 Thread，`thread/resume` 重新打开已存储 Thread，使后续 `turn/start` 追加到该 Thread。Bridge 不用 `thread/read` 替代 Resume，因为它不会载入或订阅 Thread。参见 [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)。

## Binding Key

Thread Binding 位于 Profile 边界内，并由以下字段确定：

- Account-scoped Conversation Key；
- 默认使用 `conversation` Scope；或
- 配置群成员隔离时，使用 `participant` Scope 加 Provider Identity。

私聊始终使用 Conversation Scope，因为其 Conversation Key 已包含 Provider-stable Private-conversation Identity。新的 Profile Store 只记录 Binding ID、Key、Codex Thread ID 和 Binding Time。

## Process Generation

`TurnCoordinator` 只在内存中保存本代进程已载入的 Thread ID。成功的 `thread/start` 会载入新 Thread；新 App Server 进程第一次使用已有 Binding 时调用 `thread/resume`，同代后续 Turn 不再重复 Resume。若 Resume Response 返回了不同的 Thread，Bridge 会在 `turn/start` 前失败关闭。

## 输入顺序

对已准入的 Channel Message，`ConversationTurnCoordinator` 依次执行：

1. 解析或创建 Thread Binding；
2. Start 或 Resume 原生 Codex Thread；
3. 使用 Archive Record ID 与唯一 `clientUserMessageId` 持久化 `accepted` Input Correlation；
4. 调用原生 `turn/start`；
5. 把返回的 Codex Turn ID 持久化为 `started`；
6. 提交 Logical Result 与全部 Outbox Segment；
7. 把 Input Correlation 标记为 `terminal`。

若 Input 已接受后结果变得不明确，Correlation 进入 `uncertain`，Bridge 不自动重放；同一 SQLite Transaction 会提交 Recovery Logical Result 与 Durable Channel Outbox Record。Terminal Text 按 Unicode Character Boundary 切为不超过 64 KiB 的 Outbox Segment。

Profile Worker 现已把规范化 Adapter Event 依次送入唯一 Inbound Pipeline、Access Policy、Command Parser 和 Admission Controller，然后才调用该 Coordinator。在 Steer Mode 下，同一 Active Binding 的第二条普通消息使用精确 `threadId` 与 `expectedTurnId` 调用原生 `turn/steer`。其 Accepted Correlation 会附着到该 Turn 并进入相同终态；Steer Outcome 不明确时改为 `uncertain`，不自动重放，并产生同样的 Durable Uncertainty Notification。

## Schema

Thread Binding、Codex Input Correlation 与可恢复 Logical Result Source 属于 Bridge Profile Schema Version 5。旧 Store 以 `migration_required` 失败关闭；普通 Service Startup 绝不自动迁移。
