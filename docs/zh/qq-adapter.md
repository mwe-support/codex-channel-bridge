# QQ Adapter 基线

`0.2.0-rc.1` 增加显式启用的[自动输出文件投递](output-files.md)，使用 SDK 上传及独立的
持久序号媒体消息发送，覆盖私聊与群聊。收件客户端下载验收待完成，不代表已发布。

## 所有权与依赖

`@codex-channel-bridge/qq-adapter` 是共享 `ChannelAdapter` 接口背后的
Channel-owned 边缘。它把腾讯官方 `@tencent-connect/qqbot-nodejs` 精确固定在
`1.0.4`。Adapter 只负责 QQ 协议转换，不拥有 Access Policy、Profile Routing、
Codex Thread 或 Turn、Admission 或 Durable Delivery Policy。

完整的 Provider 调研与来源链接见
`docs/zh/research/qq-official-sdk-contract.md`。

## 启动与 Profile 生命周期

每个 Enabled QQ Channel Account 都在其所属 Profile Worker 内创建一个 SDK
Client。只有 Profile-local Secret Resolver 解析配置的 `appId` 和 `appSecret`
Reference 后，Credential 才会注入 Client。SDK 不会自行发现 Environment File。

Client 使用 WebSocket Transport、同步 Token Prefetch，并且只订阅
`GROUP_AND_C2C_EVENT` Intent（`1 << 25`）。Bridge 用不含内容的 Logger 替换
SDK Logger，因为 SDK 的 Debug Output 可能包含 Provider Payload 和 HTTP Body。
启动必须在 30 秒内到达 SDK `ready` 或 `resumed` Event。失败或超时的账号会被
停止，并让 Profile 以 `channel_adapter_unavailable` 原因进入 `degraded`；健康的
Sibling Adapter 与该 Profile 的 Codex App Server 仍可使用。

Drain 会先独立停止每个 Adapter，再关闭 App Server 和 Profile Store。当前基线
尚未实现 Adapter 自动重启，也没有在连接就绪后失败时持续报告每个账号的
Readiness。

## 入站规范化

Adapter 只接受 C2C 与 QQ 群消息 Event。它先应用官方 SDK Content Sanitizer，
再生成一个只包含 Provider Fact 的 Channel-neutral Provider Event：

- C2C 消息使用 `user_openid` 同时作为稳定 Participant 与 Provider Conversation
  Identity，并标记为 `direct`。
- 群消息使用 `group_openid` 表示 Conversation，使用 `member_openid` 表示
  Participant。`GROUP_AT_MESSAGE_CREATE` 标记为 `mention`。官方 Payload 中的
  `mentions[].is_you` 也具有权威性，因为 QQ 可能通过 `GROUP_MESSAGE_CREATE` 投递
  Desktop Client 的机器人 Mention。其他全量群消息 Event 标记为 `passive`。
- `0.2.0-rc.1` 还会在核心命令解析前，清理提供商已确认对 Bot 发起的群消息开头提及标记，
  覆盖 SDK 1.0.4 仅匹配 AppID 时遗漏的不透明 ID。保留私聊/未提及正文以及正文中间的提及。
  将来固定 SDK 已能处理该情形且适配器到核心的契约测试仍通过时，移除此额外规范化。
- Durable Provider-event Key 编码 Provider Message ID，并在存在时同时编码
  `msg_idx`。
- 该 Event 无法声明自身的 Profile、Channel Account、Account Epoch 或 Bridge
  Conversation Key。所属 Profile Worker 把这些 Trusted Context 注入唯一的
  Inbound Pipeline；Pipeline 派生 Conversation Key，在把新 Event 暴露给后续
  Routing Work 前先提交 Message Archive，并且不再次暴露 Duplicate Event。
- Provider Identifier 始终是内部数据。Operational Output 不得记录这些标识或
  Message Body。

固定版本 SDK 会在等待应用提交前推进 Gateway Resume Sequence。因此 Adapter 在 SDK
Middleware 与 Session Persistence Seam 上安装一个窄范围的固定版本 Coordinator。它先
暂存 SDK 提前产生的 Checkpoint，在 Middleware 发生 Yield 前捕获对应 Sequence，并且
只有在 Inbound Pipeline 已提交 Message Archive 后，才把 Sequence 写入 Profile SQLite。
并发消息按有序前缀提交：后一个 Archive Operation 即使先完成，也不能越过前一个尚未
提交的消息推进 Resume。Schema 7 为每个 Channel Account 保存一个 Session-aware
Transport Checkpoint。Sequence 在同一个 Gateway Session 内不能后退；确认替换 Session
后可以从较小的 Provider Sequence 开始。重启时只把这个 Durable Session 与 Sequence
提供给 SDK Resume；已观察但未提交的 Event 仍可被重放，而已经提交 Archive 的 Event
会由 Provider-event Key 去重。

该 Compatibility Shim 只适用于 SDK `1.0.4`。官方 SDK 提供可等待的 Post-commit Cursor
Interface 后必须移除，并且其 Contract Test 必须继续绑定已安装 SDK 的准确行为。

## 文本投递

### `0.2.0-rc.1`：私聊原生答案流

工作区实现将 Codex `final_answer` item 增量投射到 QQ C2C 原生流式接口，
使用 SDK 1.0.4 的鉴权 API 入口。SDK 上层流式 helper 要求同时传两个锚点；此处按腾讯契约
只发送 `msg_id`。使用 `input_mode=replace` 发送累积全文，保持 `msg_seq` 与流身份不变、
递增帧序号，仅由已提交的终态 Outbox 租约发送 `input_state=10`。
成功 DONE 回执在重启后可恢复，不再补发普通完整答案。审批消息不能结束答案流。
QQ 群聊及 WhatsApp 保留完整结果投递。

首帧后按 500 毫秒合并更新，每条流最多一个在途请求、5,000 字符有界投射。
不流式展示推理、commentary 或工具输出。短答案可能在首个生成帧发送前就已完成。
思考/工具执行期间可能尚无答案文本；此功能不是输入中气泡。`remain_msg_len` 仅记录为
提供商元数据，不作为可写容量：真实 QQ 在它为零时仍接受续帧及 DONE。
由实际提供商失败触发回退，而非该提示值。

Schema 10 仅保存投递元数据及前缀摘要。不确定帧、前缀变化、容量错误与流发送失败通过
普通持久 Outbox 回退；无法核实的已接受帧/DONE 可能留下部分气泡或造成重复。
不承诺提供商取消或对账能力。超长 QQ 结果完整分段，不拆开 Unicode 字符对、不丢正文。
生成帧成功本身不代表最终投递成功。

当前为 **`0.2.0-rc.1` / 待完整验收**。
真实私聊增量展示与 DONE 已通过；其余边界覆盖见下方证据。
参见[迁移要求](migrations.md)与[验收证据](acceptance/qq-native-streaming.md)。

`sendText` 把规范化 Private Target 映射到官方 C2C Route，把 Group Target 映射到
官方 Group Route。Provider 成功响应会生成 `accepted` Receipt。明确且非限流的
4xx Failure 归类为 `rejected`；HTTP 429 归类为 `deferred`，由 Durable Outbox 执行
有界 Backoff 与 Jitter。Transport Failure 及 QQ 可能已经接受请求的其他结果归类为
`ambiguous`，并使用同一个 Logical Result Identity 重试。

被动投递必须携带 Outbox 分配的 `providerReplySequence`。Adapter 通过 SDK 的显式
`send`/Raw Path 传递已持久化的 `msg_id + msg_seq`，因此 Ambiguous Outbox Retry 不会
消耗新的回复次数。缺少 Durable Sequence 的被动投递会在本地被拒绝。

只有 QQ 使用文档化 Business Code `304103` 或 `40034005` 明确拒绝过期 Anchor 时，
Adapter 才会去掉 `msg_id` 重试一次。其他 Error 不会触发主动降级。用户可能已关闭主动
消息，所以降级被拒仍是 Delivery Failure，不能表述成 Codex Result 成功送达。Response
丢失仍无法通过 Provider Lookup API 对账，Bridge 不宣称 Strict Exactly-once Result
Delivery。

## 验证

Unit Contract 覆盖精确 Intent 与 Transport、C2C/Group Provider-fact
Normalization、Mention 与 Passive Attention、Accepted/Rejected/Ambiguous Delivery
Mapping、Rate-limit Deferral、稳定被动序号传递、窄范围过期 Anchor 降级、无关错误
拒绝以及启动失败。
Inbound Pipeline 与 Profile Worker Contract 覆盖 Trusted
Authority Injection、Archive-before-routing、Deduplication、Provider Mismatch
Isolation、Adapter 独立失败、Durable Checkpoint Injection 和 Drain。Checkpoint Contract
还覆盖 Restart Restore、Invalid-session Clearing、Commit Failure 与并发 Archive
乱序完成。

可选真实测试会连接已配置 Robot，等待一条 Inbound Event，并发送一条固定的被动
回复：

```sh
BRIDGE_QQ_LIVE_SECRETS_FILE=/absolute/path/to/secrets.env \
npm run test:qq-live
```

测试只输出不含内容的 Phase 和 Outcome 字段。仍需通过 Live Acceptance 解决的
问题包括 Robot 的 C2C/Group Permission、Group Sandbox Admission、Outbound IP
Permission、Duplicate Behavior 和 Provider Receipt Semantics。

2026-08-26，已配置 Test Robot 成功到达 Gateway `ready`，把一条 Full-group Message
接收为 `group` + `passive`，固定回复得到 Provider `accepted` Receipt，并且该回复
在 QQ Desktop Client 中独立可见。测试 Output 没有写入 Credential、Provider
Identity、Provider Message ID 或 User Message Body。C2C、仅 Mention 的 Group
Delivery、Resume、Rate Limit 与 Duplicate/Reconciliation Behavior 仍未验证。

2026-08-27，更新后的 Durable-sequence C2C Contract 到达 Gateway `ready`，但在 300 秒
窗口内没有收到新的 C2C Event，因此没有发送消息，并以 `live_contract_timeout` 结束。
这是未完成的外部交互，不能作为 Raw-send Path 通过或失败的证据。
