# Codex Approval Request 路由

## 原生所有权

Codex Reviewer Policy 保持权威。Bridge 不决定某项 Operation 是否需要 Approval，也绝不把 Approval Text 转换为另一个 Turn。每一代 App Server Process 使用唯一 `CodexServerRequestRouter` 接收 Server-originated Request，并在原 JSON-RPC Request ID 上回答。

当前稳定阶段支持：

- `item/commandExecution/requestApproval`；
- `item/fileChange/requestApproval`。

只接受简单原生 Decision：`accept`、`acceptForSession`、`decline` 和 `cancel`。Permission-profile Approval、Experimental Tool User-input、MCP Elicitation、Dynamic Tool Call、Legacy Approval Method 与 Account Request 在各自 Contract 实现前均失败关闭。

## Controller Binding

Approval Request 必须包含 Active Turn 的精确 `threadId` 与 `turnId`。Router 从 Profile-local Active-work Registry 取得其 Controlling Channel Participant。Response 必须匹配完整可信的 Profile、Channel Account、Account Epoch、Conversation 与 Provider Identity Context；其他已准入 Participant 也不能回答。

Request ID 只在当前 Process 内有效，并按 JSON Type 建立索引，因此 Number `1` 不会与 String `"1"` 冲突。Duplicate、Malformed、Unsupported 与 Uncontrolled Request 都收到 JSON-RPC Error。Profile Stop 或 Protocol Fault 会清除 Pending Entry，绝不把它们重放到重启后的 Process。

## Channel 展示与响应

Router 会分配一个与 App Server Request ID 不同的 Opaque、Generation-local Token。Profile Worker 通过绑定的 Channel Adapter 发送有界 Prompt。Initiator 必须准确回复以下命令之一：

```text
/approve TOKEN accept
/approve TOKEN session
/approve TOKEN decline
/approve TOKEN cancel
```

Core Parser 将 `session` 映射为 Native `acceptForSession`。命令先经过 Access Policy，随后 Router 再次检查完整 Trusted Participant Context，最后响应原始 Request。默认 `minimal` Mode 隐藏 Command 与 File Content；Profile Configuration 可以选择 `summary` 或 `detailed`，所有投射字段仍保持有界。

Response Window 默认五分钟，可按 Profile 配置。超时返回原生 `cancel`。记录确定拒绝的展示结果；延期或不确定的发送在有界响应窗口内使用既有 Outbox 重试。不确定发送可能已到达；任何投递状态都不代表授权执行，也不能延长 QQ 的平台回复权限。

`0.2.0-rc.1` 中，成功发送决定后会给渠道一条简短确认，表示已写回 Codex，不表示操作已执行成功。非法、过期、已使用或参与者不匹配的 TOKEN 得到相同的不泄露详情的拒绝提示。原生 `serverRequest/resolved` 和终态 `turn/completed` 通知使匹配的 TOKEN 失效，并拒绝未发出的提示，不再回答已被 Codex 清除的请求；不引入新的 Reviewer 决策。

## 持久传输与 Generation Boundary

Profile Store 会在一个 SQLite Transaction 中提交有界 Approval Prompt、Approval Request Record、一个 Logical Result、初始 Outbox Record 和不含正文的 Requested Audit Record。Approval Presentation 因而与 Terminal Result 共用 Delivery Lease、Receipt Validation、Ambiguous Retry 和 Provider-specific Reply Identity。

Accepted、Ambiguous 与 Rejected Presentation Outcome 会更新持久状态。通过授权的 Channel Decision 先回应原始 Process-scoped Request，再把持久 Approval Record 终结，并写入另一条不含正文的 Audit Record。Timeout 会发送原生 `cancel`、把 Record 标记为 Expired，并拒绝尚未发送的 Presentation。

App Server Request ID 始终只属于当前 Generation，绝不为了 Replay 而持久化。发生 Protocol Fault、停止或替换 Generation 进入 Ready 之前，所有仍 Pending 的持久 Approval 都会以 `app_server_generation_lost` 取消，并拒绝尚未发送的 Outbox Record。这样保留证据，同时避免发送已经无法到达 Codex 的 Token。

Audit Row 只包含内部 Approval Reference、Action、Result 和时间，不包含 Request Parameter、Prompt Text、Provider Identity、Receipt、Channel Body 或 Codex Output。Host-local Audit Query/Export Authorization 属于后续 Administration Slice。
