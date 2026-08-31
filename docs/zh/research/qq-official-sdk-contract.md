# 腾讯 QQ Bot Node.js SDK 与开放平台合同

调研日期：2026-08-26

本文评估 QQ Channel Adapter 所需的腾讯第一方 Node.js/TypeScript SDK 与 QQ
开放平台合同。调研只使用腾讯文档、腾讯所有的 GitHub 仓库和 npm Registry
Metadata；没有检查 Credential 或本地测试配置。

## 结论

`@tencent-connect/qqbot-nodejs` `1.0.4` 最符合 Bridge 的 QQ 私聊与群聊范围。
它是腾讯所有、TypeScript-first 的协议层 Package，提供 C2C 与群消息类型、REST
发送、WebSocket/Webhook Transport、Access Token 管理和公开的协议 Primitive。
较旧的第一方 `qq-guild-bot` 主要服务 QQ Guild/Channel，不适合 Bridge 所需的
QQ C2C 与 QQ 群合同。

该依赖不能“直接接入并信任默认值”。Bridge 应精确固定 SDK 版本并增加 Adapter
Contract Test，原因包括：

- QQ 官方文档说明 SDK 是参考实现，平台文档才具有权威性；
- npm 已发布 Metadata 与 Source Tag 对最低 Node 版本的声明不一致；
- SDK 在等待应用完成 Durable Processing 前就持久化 Gateway Sequence；
- 默认 Debug Logging 包含 Message、Request 与 Response Body；
- 内置 Message Deduplication 可选，且仅存在于内存；
- 普通消息发送没有通用 Retry 或 Idempotency Layer。

来源：[QQ 官方入门页](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html)、
[官方 SDK 仓库](https://github.com/tencent-connect/qqbot-nodejs)、
[SDK README](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/README.md)。

## Package 身份与 Runtime 要求

| 项目 | 已验证合同 |
| --- | --- |
| Package | `@tencent-connect/qqbot-nodejs` |
| npm Latest Dist-tag | 2026-08-26 观察到的版本为 `1.0.4` |
| Source Tag/Commit | Tag `1.0.4`，Commit `ca55d9c395b582b7fcfad0ec27209c35dd04e0b3` |
| License | MIT，Tencent 2026 Copyright |
| Module Format | Pure ESM，包含 TypeScript Declaration 与独立 `/protocol` Export |
| Runtime | npm 已发布的 `1.0.4` Metadata 与 `USAGE.md` 声明 Node `>=18`；Tag 中的 `package.json` 与 README 声明 Node `>=20` |
| 直接 Runtime Dependency | `ws` |

一手来源：[npm Latest Metadata](https://registry.npmjs.org/@tencent-connect%2Fqqbot-nodejs/latest)、
[固定版本 `package.json`](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/package.json)、
[MIT License](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/LICENSE)、
[README Requirements](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/README.md#requirements)、
[`USAGE.md` Runtime Requirement](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/USAGE.md#1-%E7%8E%AF%E5%A2%83%E8%A6%81%E6%B1%82)。

`1.0.4` Tag 的 Repository Source 声明 Node `>=20`，但 npm 中同版本 Artifact
声明 Node `>=18`。这是第一方 Metadata Drift。Bridge 应使用 Node `>=20`，精确
固定 `1.0.4`（不用 Range），在 Lockfile 中保留 npm Integrity，并测试实际安装的
Tarball，不能假设 Git Tag 与 npm Artifact 字节等同。本项目自身要求 Node 22，
已经高于这两个下限。

QQ 文档的 SDK 列表仍把较旧的
[`tencent-connect/bot-node-sdk`](https://github.com/tencent-connect/bot-node-sdk)
列为 Node.js SDK Demo。该仓库发布 `qq-guild-bot`（npm Metadata 当前为
`2.9.5`），README 也明确称其为 QQ Guild Bot SDK。新 Package 同样属于 Tencent
Connect Organization，但尚未进入 SDK Demo 列表。这种文档滞后再次说明应固定并
执行 Contract Test，不能动态追随 `latest`。来源：
[官方 SDK Demo 列表](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html)、
[`qq-guild-bot` npm Metadata](https://registry.npmjs.org/qq-guild-bot/latest)、
[旧 SDK README](https://github.com/tencent-connect/bot-node-sdk#readme)。

## Authentication 与 Client 生命周期

平台颁发 `AppID` 和 `AppSecret`。Access Token Authentication 是受支持机制，旧的
Token Authentication Mode 已弃用。Service 使用 `appId` 和 `clientSecret` 换取
`access_token`，随后在 OpenAPI Request 中发送
`Authorization: QQBot ACCESS_TOKEN`。文档中的 Token Lifetime 最长为 7,200 秒；
临近到期时可获得新 Token，旧 Token 还有 60 秒重叠有效期。

来源：[官方 Access Token 文档](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、
[官方 Authentication Guide](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html)。

SDK 只通过 `new QQBot({ appId, appSecret })` 接收 Credential，不自行读取环境变量。
默认同步 Token Prefetch 会在 Credential 无效时立即让 Startup 失败，随后启动后台
Refresh Loop。`start()` 打开所配置的 Event Transport，并一直阻塞到 `stop()` 或
AbortSignal 结束。`stop()` 终止 Transport 与 Token Refresher。每个 `QQBot`
Instance 独立拥有 Token、HTTP、Upload Cache 和 Gateway Object，因此每个 Channel
Account 使用一个 Instance，符合 Profile-local Adapter Supervision。

来源：[SDK Usage Guide](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/USAGE.md#3-%E5%87%86%E5%A4%87%E5%B7%A5%E4%BD%9C)、
[`QQBot` Lifecycle Source](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L440-L518)、
[Token Manager Source](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/token.ts)。

当前官方文档与 SDK Source 存在 Hostname Drift：文档对 Token/OpenAPI 使用
`api.bot.qq.com`，SDK 默认对 Token 获取使用 `bots.qq.com`，对 OpenAPI 使用
`api.sgroup.qq.com`。Adapter 不应在没有 Live Contract Test 时重写这些默认值；
Acceptance Suite 应针对固定 Package 验证 Token Acquisition、`/gateway` 和一次
Message Send。

## Event Transport 与 Connection 生命周期

### WebSocket

平台流程如下：

1. 通过 OpenAPI 获取 Gateway URL。
2. 连接后接收 Opcode `10`（`Hello`），其中包含 Heartbeat Interval。
3. 发送 Opcode `2`（`Identify`），包含 `QQBot {access_token}`、Intents 与 Shard。
4. 接收带 `session_id` 的 `READY`。
5. 发送 Opcode `1` Heartbeat，包含最新接收的 Sequence `s`。
6. 断线后发送 Opcode `6`（`Resume`），包含 Token、Session ID 与最后处理的
   Sequence；Gateway Replay 后续 Event，并以 `RESUMED` 结束。

官方 Event 页面把通用 Payload 定义为顶层 `id`、`op`、`d`、`s` 和 `t`。`id`
是 Event ID，`s` 是 Downstream Sequence，`t` 是 Event Type。官方明确建议在处理
Event 后持久化 `s`，使 Resume 能重放其后的 Event。

来源：[官方 Event Subscription 与 Gateway Lifecycle](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)。

SDK 实现 Heartbeat、Identify、Resume 和 1、2、5、10、30、60 秒固定重连延迟，
最多 100 次。它对 Gateway Close Code `4008` 等待 60 秒；对无效、越界或超时的
Session 清除状态；Authentication Failure 后刷新 Token；把不足或禁止的 Intent
视为 Fatal。

来源：[Gateway Constants](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/constants.ts)、
[Gateway Lifecycle](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/gateway-connection.ts)、
[Reconnect State Machine](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/reconnect.ts)。

以下两个 SDK 行为不足以满足 Bridge Durable Delivery Contract：

- 每个 Frame 到达时，SDK 在把 Message 分发给应用之前就把 `lastSeq` 写入
  Persistence Port；
- Message Handler 启动后不会等待其完成。

因此，如果 SDK 推进 `lastSeq` 后、Bridge 提交 Normalized Event 前发生 Crash，
Resume 可能从尚未提交的 Message 之后开始。首版不得把 SDK `sessionPersistence`
Hook 当作 Durable Acknowledgement。Adapter 需要固定版本 Contract Test，并需要
上游支持 Post-commit Sequence Acknowledgement，或一个有明确移除条件的狭窄协议层
Wrapper。

证据：[`lastSeq` Persistence 早于 Dispatch](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/gateway-connection.ts#L203-L240)。

### Webhook

平台也支持 HTTPS Callback。它要求已配置的 HTTPS Address，允许 80、443、8080
和 8443 Port，验证 Callback、签名 Event Request，并期望 Opcode `12` ACK。SDK
验证 Ed25519 Signature，对有效 Dispatch 立即 ACK，并在后台执行 Handler，因此
长任务不会导致 Callback Timeout 与 Redelivery。

来源：[官方 Webhook Contract](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#webhook%E6%96%B9%E5%BC%8F)、
[SDK Webhook Transport](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/transport/webhook.ts)、
[Signature Implementation](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/transport/webhook-verify.ts)。

首版选择 WebSocket 的运维复杂度较低，因为无需暴露公共 HTTPS Callback。但这只
应是配置的 Transport Choice，不能假设平台会长期保留：旧的官方 BotGo README
警告 WebSocket 将下线，而 2026 年 7 月的当前平台文档与新 Node SDK 又同时积极
描述两种 Transport。该第一方矛盾要求 Live Capability Test 和显式的未来 Webhook
Edge，不能隐藏切换。来源：[BotGo Notice](https://github.com/tencent-connect/botgo#%E6%B3%A8%E6%84%8F%E4%BA%8B%E9%A1%B9)、
[当前官方 Event 文档](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)、
[新 SDK Transport 文档](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/README.md#dual-transport-websocket--webhook)。

## 私聊与群聊入站合同

所需 Gateway Intent 是 `GROUP_AND_C2C_EVENT (1 << 25)`。官方文档在该 Intent
下列出 `C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE` 及相关好友/群生命周期和
接收/拒绝 Event。Subscription Permission 由平台控制，请求未授权 Intent 会关闭
Connection。

来源：[官方 Intents Table](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#%E4%BA%8B%E4%BB%B6%E8%AE%A2%E9%98%85intents)。

| Bridge 含义 | Provider Event 与字段 | 应保留的 Identity Key |
| --- | --- | --- |
| 私聊消息 | `C2C_MESSAGE_CREATE`：`d.id`、`d.author.user_openid`、`d.content`、`d.timestamp`，以及可选 Attachment/Message Scene/Element | Channel Account Epoch + `user_openid` |
| 群 @ 消息 | `GROUP_AT_MESSAGE_CREATE`：Message ID、`group_openid`、Author `member_openid`、Content、Timestamp、Mention 与 Attachment | Conversation：Account Epoch + `group_openid`；Participant：Account Epoch + `group_openid` + `member_openid` |
| 全量群消息 | 启用“接收全部消息”时的 `GROUP_MESSAGE_CREATE`，字段与群 @ Event 相同 | 与群 @ 消息相同 |

来源：[C2C Message Event](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)、
[Full Group Message Event](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)、
[SDK Protocol Types](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/types.ts#L247-L293)、
[SDK Event Normalizer](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/event-dispatcher.ts#L157-L273)。

`username` 是 Display Data，不是 Identity。官方 Event Schema 还提供
`union_openid` 与 `union_user_account`，但明确说明它们可能为空。首版 Adapter
不得基于 Name 或假定的跨上下文 Mapping 合并 C2C `user_openid` 与群
`member_openid`，也不得合并不同 Channel Account 的 Identity。

## Provider Event ID、Replay 与入站去重

对 Message Event，`d.id` 是 Message ID，也是被动回复和 Recall 使用的 ID。外层
Payload 还可能有自己的 Event `id`；Gateway `s` 是 Resume Sequence，不是 Durable
Business ID。平台警告同一 Message ID 可能重复投递。当前 Message Event 文档要求
把 Message Identity 与 `message_scene.ext` 中的 Message Index（`msg_idx`）组合用于
Deduplication。

来源：[Common Event Payload](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#%E9%80%9A%E7%94%A8%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84-payload)、
[C2C Deduplication Notice](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)、
[General Message Deduplication Rule](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html#%E6%B6%88%E6%81%AF%E5%8E%BB%E9%87%8D)。

Bridge 应从 Channel Account Epoch、Provider Message ID 与可选 `msg_idx` 构建
Durable Provider-event Identity。外层 Event ID 与 Gateway Sequence 仅作为独立的
Correlation/Reconciliation Metadata。Codex Work 开始前，必须在 Profile Database
完成 Deduplication。

SDK 可选的 `messageFilter()` 默认只在 In-memory Map 中记住 Message ID 五秒。它
可降低即时 Self-echo/Duplicate Noise，但不是 Durable Deduplication Boundary，也
无法跨 Restart。来源：[SDK Message Filter](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/middleware/message-filter.ts)。

## 发送与回复合同

### Target 与 Route

| Scope | REST Route | Target Identifier |
| --- | --- | --- |
| C2C 私聊 | `POST /v2/users/{user_openid}/messages` | `user_openid` |
| QQ 群 | `POST /v2/groups/{group_openid}/messages` | `group_openid` |

SDK 使用 `ReplyTarget { scope: "c2c" | "group", targetId, msgId? }` 表示它们，
并从 C2C `user_openid` 或群 `group_openid` 派生 Target。来源：
[SDK Routes](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/routes.ts#L9-L11)、
[`ReplyTarget` 与 Target Derivation](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L77-L91)、
[Derivation Source](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L1100-L1109)。

### 被动回复与主动发送

- 被动回复携带 `msg_id`；响应非 Message Event 时改为携带 `event_id`。
- `msg_seq` 与 `msg_id` 组合。同一 `msg_id + msg_seq` 重复发送会失败；递增
  `msg_seq` 可以对同一 Inbound Message 回复多次。
- 主动消息省略 `msg_id` 和 `event_id`。用户可禁用主动消息，此时发送失败。
- `is_wakeup=true` 是独立 Interaction-recall Mode，与被动 Identifier 互斥。
- Text 使用 `msg_type=0` 与 `content`；Markdown 使用 `msg_type=2` 与 `markdown`；
  Rich Media 使用 `msg_type=7` 与先上传获得的 `media.file_info`。

来源：[官方 Message Overview](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)、
[官方 Group-send Request Fields](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、
[SDK Message API](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/messages.ts)。

成功发送返回 Provider Message `id`、Timestamp 和可选 `ext_info.ref_idx`。Provider
Message ID 是 Delivery Correlation 与后续 Recall 所需的 Receipt Identity；
`ref_idx` 是 Quoted Reply 的 Reference Identity。来源：
[官方 Group-send Response](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html#%E5%93%8D%E5%BA%94)。

### Reply Window 与 Frequency Hint

当前官方概述中的限制为：

| Scope | 被动回复窗口 | 每条入站消息可回复次数 |
| --- | --- | --- |
| C2C | 概述与页面摘要写 60 分钟 | 4 |
| Group | 5 分钟 | 5 |

但同一页面的 C2C Request Field Description 又写 `msg_id` 五分钟内有效，锁定 SDK
的流式指南也要求使用前五分钟内的入站消息。因此，第一版必须先保守地把五分钟作为
运行边界，直到
[`qq-long-running-delivery-limits.md`](qq-long-running-delivery-limits.md)
列出的真实机器人测试验证当前 Provider 行为。以上两个数值都不能证明一条流的最长
寿命。

对于主动消息，官方 Overview 当前列出：已认证 Bot 的 C2C Limit 为 10 QPS，未认证
Bot 为 5 QPS 加 30 QPM；每个 Relationship 20 QPM，每个 User 每日上限 1,000。
Group 侧已认证 Bot 为 60 QPM，未认证 Bot 为 30 QPM；每个 Relationship 20 QPM，
每个 Group 每日上限 1,000。这些是 Platform Limit，不是安全运行目标；Provider
Error 和未来文档变更仍具有权威性。

来源：[官方 Frequency 与 Validity Rule](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html#%E9%A2%91%E7%8E%87%E4%B8%8E%E6%97%B6%E6%95%88%E8%A7%84%E5%88%99)。

### Retry 与不确定结果

SDK 普通 Message Path 只执行一次 HTTP Request，并抛出包含 HTTP Status、Platform
Business Code、Message 与 Route 的 Structured `ApiError`。通用 Response Body
没有公开 Documented Idempotency Key 或按 Client Result ID 查询的 API。SDK 对
Media Upload Stage 有 Retry Policy，但普通 C2C/Group Message POST 没有通用自动
Retry。

来源：[API Client](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/api-client.ts)、
[Message Send Implementation](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/messages.ts#L65-L102)、
[Retry Policies](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/retry.ts)。

对被动发送，SDK Helper 每次 `sendText()` 都生成新的 Random/Time-derived
`msg_seq`。Durable Outbox Retry 必须改为持久化原始 `msg_id` 和选定的 `msg_seq`，
并使用 Raw Send API，避免意外消耗另一个 Reply Slot。不确定 Network Outcome
不能宣称 Exactly Once：使用相同 Pair 重试时，第一次可能已成功，从而重试被拒；
主动发送则没有 Documented Equivalent Idempotency Pair。Outbox 必须保留一个
Logical Result、记录 Ambiguity，并披露小范围 Duplicate/Uncertain Window。

证据：[SDK Sequence Generation 与 Raw-send Behavior](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/messages.ts#L65-L102)、
[Route Sequence Helper](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/routes.ts#L55-L65)。

## Sandbox 与 Production 差异

腾讯官方 BotGo Quick Start 说明：Robot 发布前，只有已配置 Sandbox Member 能访问，
新建 Robot 默认把 Creator 加入 Sandbox；OpenAPI Access 还受配置的 Outbound-IP
Allowlist 限制。示例中的 Production Initialization 使用相同 OpenAPI Client；
Sandbox 区别属于 Account/Audience Configuration Boundary，不是单独 SDK Class 或
替代 API Host。

来源：[官方 BotGo Quick Start](https://github.com/tencent-connect/botgo#%E4%B8%80quick-start)。

新 Node SDK 只有一组默认 Token、API 与 Gateway Host，没有 `sandbox` Option。因此
Adapter 应把 Sandbox/Production 视为平台侧 Robot Status 与 Audience/IP
Configuration。不得创造第二套 Identity Namespace 或静默切换 Endpoint。Live
Acceptance 必须分别证明：

1. Test Member/Account 可以发起 C2C Interaction；
2. 已配置 Test Group 被准入并产生预期 Group Event；
3. Deployment Outbound IP 被接受；
4. 所选 Intents 获得授权；
5. Proactive-message Test 遵守 Test Robot 当前 Platform Permission 与 Quota。

来源：[`QQBotOptions`](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L121-L181)、
[官方 Intent Permission Rule](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#%E6%9D%83%E9%99%90)。

## 本仓库要求的 Adapter Boundary

根据已验证 Provider Contract，QQ Package 应作为 Channel-owned Protocol
Dependency，位于 Bridge 的 Channel-neutral Adapter Interface 背后。Bridge 继续
负责 Profile Routing、Durable Inbound Deduplication、Access Policy、Durable
Outbox State、Retry、Provider Receipt 与 Restart Reconciliation。

首版 Adapter 应执行以下 Gate：

1. 把 `@tencent-connect/qqbot-nodejs` 精确固定为 `1.0.4`，Node 使用 `>=20`。
2. 从已经解析的 Secret Reference 注入 `AppID` 与 `AppSecret`；不允许 SDK 或示例
   发现 Environment File。
3. 只订阅 `GROUP_AND_C2C_EVENT` 与其他显式需要、平台授权的 Intent，不使用 SDK
   宽泛的 `FULL_INTENTS`。
4. 只规范化上文列出的 Provider Field；Raw Platform Payload 只在 Message Archive
   Contract 明确允许时保留。
5. 接受 Codex Work 前提交 Inbound Identity/Dedup State。
6. 不直接依赖 SDK 提前写入的 Session Persistence。固定 `1.0.4` Adapter 必须把它转换为
   Archive 提交后的有序前缀 Durable Checkpoint；上游提供可等待 Cursor 后移除 Shim。
7. 在 Outbox 持久化被动 `msg_id` 与 `msg_seq`；使用 Provider Response `id` 和
   `ext_info.ref_idx` 作为 Delivery Receipt。
8. Provider Throttling 与 Bounded Jitter 保持在 Adapter 内；SDK 固定 Reconnect
   Sequence 与仅限 Media 的 Retry 不能代替 Bridge Policy。
9. 传入 Content-redacting Logger。SDK 在 Debug Level 记录完整 Gateway Payload、
   Webhook Event Body、REST Request Body 与 REST Response Body，原样转发会违反
   Bridge Operational-log Boundary。
10. 在宣称 Profile Adapter Ready 前，对 Token Acquisition、Gateway Ready/Resume、
    C2C/Group Normalization、Duplicate Delivery、Passive Reply、Provider Receipt、
    Rate-limit/Error Mapping、Disconnect 和 Restart 执行 Contract Test。

Logging 证据：[Gateway Payload Debug Log](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/gateway-connection.ts#L219-L223)、
[REST Request/Response Body Log](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/api-client.ts#L75-L115)、
[Webhook Payload Debug Log](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/transport/webhook.ts#L187-L194)。

## 需要用真实 Test Robot 解决的开放合同问题

一手来源无法确认以下事实是否适用于这个特定 Robot，因此它们必须保持为 Live
Acceptance Question，不能当作 Assumption：

- Robot 当前是否拥有 C2C、Group @、Full-group Message、Markdown、Media、Button
  与 Streaming Permission；
- Sandbox 当前是否允许该 Robot 进行 QQ Group Test；
- 缺少 Intent 或 IP Restriction 时，Account 实际返回哪些 Gateway Close/Error Code；
- 不确定 Network Outcome 后，平台对同一被动 `msg_id + msg_seq` 的 Duplicate
  Rejection 是否能与其他 Failure 可靠区分；
- 是否存在 Proactive Send 的 Provider Reconciliation API（已审阅来源中没有文档）。

这些问题可以在不暴露 Credential Value 的情况下测试：只报告 Capability Name、
Stable Reason Code、Provider HTTP/Business Code 和不含内容的 Correlation Identifier。
