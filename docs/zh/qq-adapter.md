# QQ Adapter 基线

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
再生成一个 Channel-neutral Event：

- C2C 消息使用 `user_openid` 同时作为稳定 Participant 与 Provider Conversation
  Identity，并标记为 `direct`。
- 群消息使用 `group_openid` 表示 Conversation，使用 `member_openid` 表示
  Participant。`GROUP_AT_MESSAGE_CREATE` 标记为 `mention`，全量群消息 Event
  标记为 `passive`。
- Durable Provider-event Key 编码 Provider Message ID，并在存在时同时编码
  `msg_idx`。Profile Store 在把 Event 交给后续 Routing Work 前，先在 Channel
  Account Epoch 内持久去重。
- Provider Identifier 始终是内部数据。Operational Output 不得记录这些标识或
  Message Body。

SDK 在等待应用提交之前就推进 Gateway Resume Sequence。因此当前基线不配置 SDK
Session Persistence，也不宣称具备 Crash-safe Gateway Acknowledgement。要关闭这一
Provider 缺口，需要针对固定版本的 Contract Shim，或上游提供 Post-commit Cursor
API。

## 文本投递

`sendText` 把规范化 Private Target 映射到官方 C2C Route，把 Group Target 映射到
官方 Group Route。Provider 成功响应会生成 `accepted` Receipt。明确且非限流的
4xx Failure 归类为 `rejected`；Rate Limit、Transport Failure 及其他不确定结果
归类为 `ambiguous`。

该方法目前只足以支持受控 Live Contract。官方 SDK 每次调用被动回复 Helper 都会
新建 `msg_seq`。生产级 Durable Delivery 必须先持久化选定的
`msg_id + msg_seq` Pair，再使用 Raw Provider Send API。Outbox 实现这一规则前，
Bridge 不宣称 QQ Result Delivery 达到 Effectively-once。

## 验证

Unit Contract 覆盖精确 Intent 与 Transport、C2C/Group Normalization、Mention 与
Passive Attention、Accepted/Rejected/Ambiguous Delivery Mapping 以及启动失败。
Profile Worker Contract 覆盖 Secret Resolution、Archive-before-routing、Adapter
独立失败和 Drain。

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
