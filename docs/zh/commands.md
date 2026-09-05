---
title: Channel 命令
---

# Channel 命令

QQ 与 WhatsApp 由 Bridge 解析同一套命令。命令改变状态前，必须先通过 Access
Policy 与 Active Controller 校验。使用 `//` 开头，可向 Codex 发送一个字面量 `/`。

| 命令 | 效果 |
| --- | --- |
| `/help` | 在本地显示支持的语法，不创建 Codex Turn。 |
| `/status` | 在本地显示 Profile Readiness、活动工作和队列状态。 |
| `/new` | 解除当前 Binding，使下一条获准消息创建新的原生 Thread。 |
| `/attach THREAD_ID` | 仅当原生 Thread 的实际工作目录等于 Profile Workspace 时建立绑定。 |
| `/detach` | 删除 Bridge 管理的 Conversation 到 Thread Binding。 |
| `/stop` | 对精确的活动 Thread 与 Turn 调用原生 `turn/interrupt`。 |
| `/approve TOKEN DECISION` | 使用有界不透明 Token 回答原始原生 Approval Request。 |
| `/model` | 显示当前绑定的原生 Thread 模型，不修改设置。 |
| `/reasoning` | 显示当前绑定的原生 Thread 思考强度，不修改设置。 |
| `/model MODEL_ID` | 选择原生 `model/list` 返回的模型。 |
| `/reasoning EFFORT` | 选择当前原生模型支持的推理强度。 |

`/model` 与 `/reasoning` 投射到原生 Thread Settings；Bridge 不维护竞争性的目录或
Profile 级选择。Approval Token 会过期、不能复用，并且只允许已授权的控制参与者
使用。

无参数查询复用仅传 `threadId` 的 `thread/resume`，读取原生响应中的
`model` / `reasoningEffort`；不发送设置覆盖或模型 Turn。Codex 可能加载尚未加载的
Thread。空强度显示为 `Codex default (unspecified)`，Bridge 不猜测实际强度。
查询要求已有绑定，可在授权共享群聊使用，不依赖实验性设置更新能力。
带参数命令保留原有能力检查及共享群聊管理员限制。
参见 [FR-007](feature-requirements.md#fr-007--查询当前模型与思考强度) 与
[原生 App Server 契约](https://developers.openai.com/codex/app-server)。

QQ 群聊先通过真实成员选择器提及 Bot，再输入命令。提供商已确认对 Bot 的群聊提及时，
适配器在核心解析前清理开头的 QQ 提及标记（包括不等于 AppID 的不透明 ID）。
未提及事件以及正文中间的提及不做此清理。

默认 `steer` 准入模式下，同一活动 Binding 的第二条获准普通消息使用带精确
Expected Turn 的原生 `turn/steer`，不会创建新 Turn 或通用队列。详见
[准入](admission.md)、[Thread Binding](thread-binding.md)与
[审批路由](approval-routing.md)。
