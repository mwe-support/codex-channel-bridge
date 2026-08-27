# QQ 开放平台长周期任务消息投递限制

调研日期：2026-08-27

本文评估 QQ Bot 能否像 Codex 原生客户端一样展示长周期 Codex 任务。资料只来自腾讯 QQ
机器人官方文档，以及本仓库精确锁定的腾讯官方 SDK：
**@tencent-connect/qqbot-nodejs 1.0.4**，提交
**ca55d9c395b582b7fcfad0ec27209c35dd04e0b3**。本次没有读取凭证或消息正文，也没有
发送真实消息。

证据标签：

- **平台事实**：当前 QQ 机器人官方文档明确陈述的规则。
- **SDK 源码观察**：直接从腾讯官方锁定版本源码观察到的行为。
- **Bridge 推论**：由平台规则导出的设计结论，不是腾讯保证。
- **未知项**：已检查的一手资料无法确定的问题。

## 结论

Bridge 不能把 QQ 整体建模成 Codex 式流式交互界面。

- QQ 确实有更新同一消息的流式接口，但只支持 C2C 私聊。
- QQ 群聊明确不支持流式参数。
- 被动回复同时受时间窗口和每条入站消息可回复次数限制。
- 延迟主动投递可被用户或群管理员关闭，而且受额度限制。
- 因此，长 Codex Turn 成功不代表最终结果一定还能通过原始 QQ 交互送达。

默认应立即持久化并发送任务接受回执，只稀疏投递状态变化，最后投递一个持久化结果。
C2C 流式能力在真实机器人契约测试通过前只是可选能力；群聊始终使用离散消息。最终
发送时，Bridge 必须选择仍有效的被动回复、获准的主动消息，或明确要求用户重新交互。

## 1. 被动与主动消息限制

| 场景 | 被动有效期 | 每条入站消息可回复次数 | 主动消息 Bot 维度 | 单关系维度 | 单关系每日上限 |
| --- | ---: | ---: | ---: | ---: | ---: |
| C2C | 页面摘要写 60 分钟 | 4 次 | 已认证：10 QPS；未认证：5 QPS 且 30 QPM | 20 QPM | 每用户 1,000 条 |
| 群聊 | 5 分钟 | 5 次 | 已认证：60 QPM；未认证：30 QPM | 20 QPM | 每群 1,000 条 |

**平台事实。** 官方
[消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)、
[单聊发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
和
[群聊发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
均给出以上数值（检索日期：2026-08-27）。普通 C2C 和群聊发送接口各标明 100 QPS，
但接口上限不能替代上表更严格的主动消息额度。

**平台事实。** QQ 用户可以关闭主动消息。Gateway 也提供
C2C_MSG_REJECT / C2C_MSG_RECEIVE 和 GROUP_MSG_REJECT / GROUP_MSG_RECEIVE
关系状态变更事件。
参见官方
[事件 Intents 表](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#%E4%BA%8B%E4%BB%B6%E8%AE%A2%E9%98%85intents)
（检索日期：2026-08-27）。

is_wakeup 互动召回不是通用长任务通道。官方概述只允许在用户交互后的 30 天中，分别
在当天、1-3 天、3-7 天和 7-30 天四个周期各发送一条。

### 腾讯一手资料内部冲突

当前 C2C 页面摘要写 60 分钟、最多四次，但同一页面的 msg_id 字段却写五分钟内有效。
腾讯 SDK 使用指南也称，流式消息必须基于五分钟内的入站消息。流式 API 没有公布独立
的起始窗口或最长寿命。

**未知项。** 现有资料不能证明五分钟字段已过时、流式窗口更窄，或 60 分钟同时适用
于普通回复和流式回复。历史上某机器人在约 395 秒或 1,917 秒后成功，只能证明当时
超过五分钟仍成功，不能证明 60 分钟契约或流式寿命。第一版应保守按五分钟设计，直到
真实边界测试记录当前提供商错误码。

来源（检索日期：2026-08-27）：

- [官方单聊发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
- [官方 C2C 流式接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
- [腾讯 SDK 流式使用指南](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/USAGE.md#11-c2c-%E6%B5%81%E5%BC%8F%E6%B6%88%E6%81%AFstream_messages)

## 2. 回复身份与重试

**平台事实。** 被动回复携带 msg_id。相同 msg_id + msg_seq 重复发送会失败；递增
msg_seq 才能继续回复同一入站消息。同一入站消息可能被重复推送，因此仍需入站去重。
参见官方
[消息去重规则](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html#%E6%B6%88%E6%81%AF%E5%8E%BB%E9%87%8D)
（检索日期：2026-08-27）。

**SDK 源码观察。** sendMessage 每次调用都会生成新的 msg_seq；调用者不提供时，
sendRaw 也会生成新值。helper 不会持久化序号，也没有结果对账能力。参见腾讯官方
[messages.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/messages.ts#L65-L102)
和
[routes.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/routes.ts#L53-L62)
（检索日期：2026-08-27）。

**Bridge 推论。** 第一次被动发送前必须持久化选定的 msg_id + msg_seq，结果不明确
时复用该组合。重试时产生新序号会消耗另一次回复机会，也可能生成用户可见的重复消息。

流式投递还必须持久化 stream_msg_id、固定 msg_seq、下一个 index、最后已接受前缀，
以及 QQ 是否接受 DONE 终止帧。

## 3. QQ 流式消息究竟是什么

**平台事实。** C2C 支持
POST /v2/users/{user_openid}/stream_messages，接口限频 50 QPS。首帧返回
stream_msg_id；后续帧携带该 ID，并从零递增 index。input_state 1 表示生成中，10
表示结束。input_mode 支持 append 或 replace；响应可包含 remain_msg_len。

replace 模式下，QQ 已经下发的正文前缀不可修改；修改会返回 40007。因此它是生成中
回答流，不是可以任意修改历史内容的通用编辑 API。

来源：官方
[C2C 流式接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
（检索日期：2026-08-27；页面更新于 2026-07-22）。

**平台事实。** 群聊发送页面明确写明群消息不支持流式参数。普通 C2C 和群聊只有撤回，
没有通用 edit/patch；消息发送超过两分钟后不能撤回。

来源：官方
[群聊发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
和
[消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html#%E6%92%A4%E5%9B%9E%E6%B6%88%E6%81%AF)
（检索日期：2026-08-27）。

### 锁定 SDK 的行为与风险

**SDK 源码观察。** StreamSession：

- 接收截至当前的完整正文，而不是 delta；
- 固定使用 replace、Markdown、一个 msg_seq 和递增 index；
- 默认 500 毫秒节流，并拒绝低于 300 毫秒；
- 遇到限流最多重试三次；
- complete() 发送 DONE；
- 没有 C2C 入站 msgId 时不能创建流。

来源：腾讯官方
[streaming.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/streaming.ts#L22-L245)
和
[QQBot.openStream](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L887-L915)
（检索日期：2026-08-27）。

300 毫秒下限是 SDK 标注的最佳实践；官方 API 页面只公布 50 QPS，没有声明 300
毫秒是协议硬限制。

**需要真实测试的 SDK 源码观察。** 官方 Schema 写明 event_id 与 msg_id 二选一，
示例也只发送 msg_id。锁定版本的 StreamSession 却默认令 eventId 等于 msgId，并
同时序列化两个字段。真实账号测试通过前不能启用该 helper；若提供商拒绝，应使用仅
携带一个被动锚点的协议层 API。

来源：官方
[流式请求字段](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
和腾讯
[请求构造源码](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/streaming.ts#L172-L197)
（检索日期：2026-08-27）。

**SDK 源码观察。** 官方流式响应定义 remain_msg_len，但锁定版本的 MessageResponse
类型和 StreamSession 没有暴露或使用该字段。因此 helper 不能按提供商返回的剩余长度
停止或分段。

### 未知的流式限制

已检查的一手资料没有公布：

- 一条流的最长持续时间；
- 最大帧数；
- 最大总正文长度或 remain_msg_len 初始值；
- 多个帧会消耗一次还是多次四次被动回复额度；
- 原始被动窗口结束后，已经开始的流能否继续；
- 中断与重启恢复保证；
- 每个机器人在生产或沙箱是否都可用。

只要项目要承诺长 Turn 流式展示，这些就是必须通过真实验收的门槛。

## 4. 内容与媒体

**平台事实。** C2C 和群聊支持文本、Markdown 与富媒体。当前官方文档称，自定义
Markdown 已向全部 C2C 和群聊机器人开放。C2C 还支持 msg_type 6 输入状态，但
input_second 最长 60 秒。

来源：官方
[消息类型](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html)、
[Markdown 文档](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html)
和
[单聊发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
（检索日期：2026-08-27）。

**未知项。** 腾讯没有说明重复输入状态会延长回复窗口，或不会消耗回复次数。它不是
长任务保活机制。

C2C 和群聊 API 列出 40054007“消息长度超限”，但没有公布普通文本或 Markdown 的
具体数值上限。流式响应有动态 remain_msg_len，却没有公布初始最大值。不能把本地
4,000 或 5,000 字符常量表述为腾讯契约。

**平台事实。** C2C 与群聊上传端点不可互用；file_info 带提供商返回的 ttl。当前媒体
限制为：

| 媒体 | 软限制 | 硬限制 | 超过软限制 |
| --- | ---: | ---: | --- |
| PNG/JPG | 20 MB | 200 MB | 降级为文件 |
| MP4 | 30 MB | 200 MB | 降级为文件 |
| SILK | 20 MB | 200 MB | 降级为文件 |
| 文件 | 200 MB | 200 MB | 超过硬限制即拒绝 |

大文件/本地文件使用预上传、分片上传、分片确认和合并。默认分片约 5 MB，但分片大小、
并发和重试策略由 upload_config 下发。

来源：官方
[富媒体概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)、
[单聊上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html)
和
[群聊上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html)
（检索日期：2026-08-27）。

## 5. Gateway、Session 与 Token

**平台事实。** Gateway Hello 下发 heartbeat_interval，客户端用最新序列号发送心跳。
短时断线可使用 session_id 和最后处理的序列号 Resume，QQ 随后补发事件。文档没有
给出固定 Session 寿命。

来源：官方
[Gateway 生命周期](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
（检索日期：2026-08-27）。

**SDK 源码观察。** 锁定 SDK 会处理重连、Session 无效或超时、序列越界、Token 刷新
和 Gateway 限流。它不会等待入站 handler 完成，因此长 handler 本身不会停止心跳。
但 SDK 会在 Bridge 持久化消息前保存 lastSeq，仍存在独立的崩溃一致性缺口。

来源：腾讯官方
[Gateway connection](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/gateway-connection.ts#L203-L268)
和
[重连状态](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/reconnect.ts#L51-L119)
（检索日期：2026-08-27）。

**平台事实。** access_token 通常有效 7,200 秒。最后 60 秒内再次获取会返回新 Token，
旧 Token 在该重叠期仍有效。SDK 会缓存 Token 并在到期前后台刷新。

来源：官方
[访问凭证文档](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
和腾讯
[Token manager](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/token.ts#L44-L165)
（检索日期：2026-08-27）。

**Bridge 推论。** Gateway Session、Codex Turn、QQ 流和最终投递是不同生命周期。
Gateway 重连不能取消 Codex Turn；Codex Turn 健康也不代表原始被动回复仍可用。

## 6. 长任务投递契约

1. 工作开始前提交入站身份和 Codex 输入关联。
2. 尽快发送一次接受回执，并持久化投递模式、被动锚点、msg_seq 和提供商回执。
3. 不把每个 Codex token 或 item 都投射到 QQ。
4. 只发送粗粒度状态变化，为失败与最终结果保留被动容量。
5. 发送终态前先提交 Logical Result 和 Outbox。
6. 投递时选择被动、主动或 awaiting_user_reentry，不无限重试明确过期的被动 ID。
7. 结果不明确时复用持久化提供商身份，并在可能重复时披露重复窗口。

C2C 在流式测试通过前，默认仍是离散接受回执加最终消息。启用后应立即开启一条流，
合并 delta、保留已下发前缀，并要求 QQ 接受 DONE。流失败后，仅在被动或主动路径仍
可用时发送一条离散最终消息。

群聊绝不提供流式选项。立即发送接受回执，抑制 token 级进度，并限制里程碑数量，不能
在最终结果前耗尽五次被动回复。预计超过五分钟的任务依赖主动消息权限；否则必须由新的
授权消息或状态命令创建新回复锚点。

至少区分：codex_failed、qq_passive_expired、qq_proactive_disabled、
qq_rate_limited、qq_stream_incomplete、qq_delivery_ambiguous 和
awaiting_user_reentry。QQ 未返回关联回执前，后端已提交结果不能被称为已送达。

## 7. 必须完成的真实验收

仅使用已配置测试机器人和无正文日志：

1. 在约 4 分 30 秒、5 分 30 秒和接近 60 分钟测试 C2C 普通回复。
2. 测试高层 SDK 同时包含 event_id 与 msg_id 的流请求。
3. 测试只含一个被动锚点、固定 msg_seq、递增 index 且 DONE 被接受的协议层流。
4. 让流跨过五分钟，记录后续帧和 complete 是否成功。
5. 确认流帧或重复输入状态是否消耗被动回复额度。
6. 在约 4 分 30 秒和 5 分 30 秒测试群回复，并测试第六次回复。
7. 分别在提供商主动消息开关开启和关闭时测试主动投递。
8. 探测普通消息长度和流式 remain_msg_len，不采用非官方数值上限。
9. 合成长任务期间断开并 Resume Gateway、轮换 Token，分别证明后端与 Outbox 连续性。
10. 对一次结果不明确的被动消息复用相同 msg_id + msg_seq，只记录错误码，不记录 ID
    或正文。

## 8. 对当前仓库的影响

当前 Adapter 只暴露离散 sendText，并保留本地 5,000 字符上限；该数值不是腾讯真实
文本限制的证据。Passive Send 现在使用 Outbox 分配并持久化的 msg_seq 和 SDK 显式
Raw-send Path，但 Response 丢失后的 Provider Reconciliation 仍不可用。

实现长任务交互前应：

1. 显式区分 QQ 投递模式：passive、proactive、c2c_stream；
2. 保留已实现的被动身份持久化，并在发送前增加流身份持久化；
3. 增加 C2C 流式和主动消息能力结果；
4. 群聊进度保持离散且独立可配置；
5. 不再把 5,000 当成 QQ 官方限制；
6. 默认启用流式前完成真实测试。

当前相关文件：

- [QQ Adapter](../../../packages/qq-adapter/src/qq-adapter.ts)
- [QQ Adapter 基线](../qq-adapter.md)
- [投递基线](../delivery.md)

这些是 Channel 所有的约束，不改变 Codex 原生 Turn、steer、中断、压缩或 Reviewer 行为。
