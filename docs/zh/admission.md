# Access、命令与 Profile-local Admission

## 有序 Inbound Boundary

每个非 Duplicate 的规范化 Channel Event 都进入唯一 `ChannelIngressController`，并按固定顺序处理：

1. 评估私聊或分层群聊 Access Policy；
2. Passive 或无 Body Event 只保留在 Message Archive，不启动 Codex Work；
3. 在 Core 中只解析一次 Bridge Command；
4. 应用 Profile-local Ordinary-input Admission；
5. Start、Steer、Queue 或明确拒绝 Work。

Adapter 只提供 Provider Fact。Profile Worker 会在该 Boundary 前注入 Profile、Channel Account 与 Account Epoch Authority。Rejected 与 Passive Event 仍是 Archive Evidence，不会成为 Outage Backlog。

## 命令

Parser 识别 `/help`、`/status`、`/new`、`/attach THREAD_ID`、`/detach`、`/stop`、`/approve TOKEN DECISION`、`/model MODEL_ID` 和 `/reasoning EFFORT`。`//text` 会转义开头 Slash，并成为普通 Codex Input。未知命令或参数数量错误会形成明确的 Invalid-command Disposition，绝不传给 Codex。

`/stop` 使用 Active Thread ID 与 Turn ID 调用原生 `turn/interrupt`，并且只有发起该 Turn 的 Provider Identity 可以调用。`/approve` 在同一 Initiator 检查后响应准确的 Pending Native Approval Request。`/help` 与 `/status` 是本地只读投射。`/new`、`/attach` 与 `/detach` 只修改 Bridge-owned Thread Binding；若 Native Thread 的解析后工作目录不同于 Profile Workspace，`/attach` 会拒绝。`/model` 与 `/reasoning` 校验原生 Model Catalog，并调用可选的原生 `thread/settings/update` Method。缺少 Native Capability 时会报告不支持，而不会模拟。共享 Conversation-scoped Group Setting 需要 Host-local Profile Administrator Control；私聊和 Participant-scoped Group Binding 可以使用这些命令。

## Steer Mode

Steer 是默认模式。同一 Thread Binding 存在 Active Native Turn 时，新的普通输入使用精确 Thread ID 与 `expectedTurnId` 调用 App Server `turn/steer`，且不占用新的 Active-turn Slot。Bridge 在原生 Request 前持久化 Input Acceptance，并让该 Correlation 随 Active Turn 进入终态。不明确的 Outcome 标记为 `uncertain`，且不自动重放。

`0.2.0-rc.1` 中默认不设置不同 Thread 之间的 Profile 并发上限：`admission.maximumActiveTurns: null`，私聊与群聊可以同时执行。管理员可显式设置有限上限，此时另一 Thread 才可能占满名额并导致 `busy`。Steer Mode 不会静默形成 Queue。同一 Thread 存在 Active Turn 但发起人/目标不允许 steer 时，仍可能返回 `busy`；取消 Profile 上限不会绕过 Thread 控制。

## Queue Mode

Queue Mode 只在 Profile Ready 时使用一个有界队列。Queue 已满时以 `busy` 拒绝最新 Input；旧 Entry 过期时不会执行，并会逐条报告。Next：Active Slot 释放后按入队顺序寻找最早 Eligible Work，跳过其 Thread 仍活动的输入；保证同一 Thread Binding 内 FIFO，不承诺全 Profile 严格 FIFO。

Next，已通过[真实 QQ 验收](acceptance/capability-and-admission-20260905.md)：队列工作晋升后，在执行前登记为活动工作。Channel 上下文与原生
Turn 目标保存在同一条活动记录中，让审批控制者查找和账户排空检查在工作释放前
始终关联到同一项工作，包括排空期间。保留既有 Turn Initiator 校验；不同 Thread 的队首跳过规则见上文。

Rate Window 按 Channel Account 分开计算。Admission State 有意保持为 Profile-local In-memory State：已接受的 Codex Correlation、Thread Binding、Archive 与 Delivery State 是持久的；Queued Ordinary Input 尚不是已接受的 Codex Work，Profile 变为 Unavailable 时会被明确丢弃。
