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

Response Window 默认五分钟，可按 Profile 配置。超时会返回 Native `cancel`。确定 Rejected 或 Deferred 的 Presentation Failure 也会立即 Cancel。Provider Send 结果 Ambiguous 时，Prompt 可能已经送达，因此 Request 保持 Pending，直到 Initiator 响应或超时。

## 当前限制

本阶段建立 Native Correlation、最小 QQ Presentation、Authorized Channel Callback 与 Timeout Handling。Approval Presentation 尚未进入 Durable Outbox，也未实现 Body-free Audit Persistence。Worker 或 App Server Restart 会取消 Process-scoped Pending State，而不是重放。完成这些 Durability 与 Audit Contract 前，不把 Channel Approval 宣称为完整 Release Feature。
