# GitHub 开源 Codex App Server 外部 Channel Bridge 调研

- 调研日期：2026-08-26（Asia/Shanghai）
- 目标：评估是否已有开源实现可让 QQ、WhatsApp 等外部 channel **直接**连接 OpenAI Codex App Server，而不依赖 Hermes/OpenClaw/LangBot 等外部 agent gateway。
- 结论先行：**没有发现可直接采用、同时满足 QQ + WhatsApp + 完整 App Server 双向协议 + 持久化隔离 + 可靠投递的开源项目。** 最合理的路线是自建一个窄而深的 bridge core，借鉴 `mideco-tech/codex-tg` 的 App Server/SQLite 控制面，复用腾讯官方 QQ SDK和 Vercel Chat 的 WhatsApp Business Cloud adapter；Telegram/Slack/Discord adapter 可随后复用或移植。

> “未发现”只表示本次检索范围内没有找到，不是对 GitHub 全量仓库不存在的证明。仓库和 Codex App Server 协议仍在快速变化，进入实现阶段前应重新核对当前 commit 和协议版本。

## 1. 需求边界与验收标准

本报告把“符合”定义为：

1. 直接使用 `codex app-server` 的 JSON-RPC（stdio 或 WebSocket），而不是每条消息 shell out 到 `codex exec`；
2. channel 会话与 Codex `threadId` 有持久映射，重启后可 `thread/resume`；
3. 能消费 `turn/*`、`item/*` 流，并以 `turn/completed` 配合 canonical item 事件收敛最终答复；
4. 有明确的 inbound 去重、durable outbox、发送回执/重试边界，避免最终答复重复或丢失；
5. 支持 `turn/steer`、`turn/interrupt`；
6. 正确处理 App Server 发起的 command/file/permission approval 和 `requestUserInput`，并把 JSON-RPC response 回到原连接；
7. 断线后能恢复 thread、订阅/轮询补偿和未完成投递；
8. 不同私聊、群聊、topic/channel 并发隔离；
9. 能处理平台媒体/文件，且符合 App Server 的输入约束；
10. secret 不落日志/仓库，webhook 有验签，channel ACL 明确；
11. 许可证允许采用或分叉，维护活跃度可接受；
12. 不引入另一个 agent/gateway runtime 作为必需管理层。

## 2. 官方协议基线

Codex App Server 官方协议已经提供本设计所需的主要原语：`thread/start`、`thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt`，以及 `turn/*`、`item/*` 事件和 server-initiated requests。官方文档还明确：

- `turn/completed` 当前的 `items` 可能为空，客户端应以 `item/*` 作为 canonical item stream；
- `turn/start.clientUserMessageId` 会回显到 `userMessage.clientId`，适合做 inbound correlation，但它**不等于**外部 channel 的投递幂等；
- `turn/interrupt` 需要 `threadId` 和 `turnId`；
- image 输入接受 data URL 或 `localImage`，拒绝远程 HTTP(S) URL，所以 channel adapter 必须先安全下载/转码；
- approvals 和 user-input 是 server 对客户端发起的 JSON-RPC request，不能用“再开一个 turn 发送 YES/NO”替代。

来源：[OpenAI Codex App Server 官方 README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、[官方文档](https://developers.openai.com/codex/app-server/)。

一个重要工程推论是：App Server 解决 agent lifecycle，不解决 Telegram/QQ/WhatsApp 侧的 exactly-once。bridge 仍需自己的 inbox 去重、outbox、幂等键和 reconciliation。官方 issue 也说明某些版本/transport 曾出现 WebSocket rollout materialization 和重复 interrupt 的恢复问题；这些是版本化风险，不能把“收到实时事件”等同于“已持久恢复”。见 [WebSocket rollout issue #16872](https://github.com/openai/codex/issues/16872) 和 [interrupt issue #36926](https://github.com/openai/codex/issues/36926)。

## 3. 候选矩阵

符号：✅ 已由源码确认；◐ 部分满足/有明显限制；❌ 不满足；— 不适用或未实现。

| 项目 | Channel | 直接 App Server | 持久 mapping / 恢复 | 流式/最终投递 | steer / interrupt | approvals / user input | 许可证 | 判断 |
|---|---|---:|---:|---:|---:|---:|---|---|
| [mideco-tech/codex-tg](https://github.com/mideco-tech/codex-tg) | Telegram | ✅ 长期进程 | ✅ SQLite + snapshot | ✅ event normalization + durable delivery queue | ✅ / ✅ | ✅ / ✅ | Apache-2.0 | **最值得借用的 control plane；需抽 channel port** |
| [anton88vlc/codex-telegram-frontend](https://github.com/anton88vlc/codex-telegram-frontend) | Telegram | ✅ stdio/WS | ✅ JSON state + resume/reconnect | ◐ live + rollout reconciliation；无严格事务 outbox | ✅ / ✅ | ✅ / ✅ | MIT | **协议覆盖很完整的参考；不宜直接当多 channel core** |
| [gl813788-byte/codex-qq-bot](https://github.com/gl813788-byte/codex-qq-bot) | QQ / OneBot | ✅，但每 turn 一个进程 | ✅ scope→thread | ◐ item/turn 收敛；无 durable outbox | ✅ / ✅ | ◐ 默认会拒绝，需 handler | 未发现 LICENSE | **唯一近似 QQ 成品；只能读设计，不能默认复制/分叉** |
| [panzhang83/codex-slack](https://github.com/panzhang83/codex-slack) | Slack | ✅，经社区 Python SDK | ✅ | ◐ live/final；无 durable outbox | ✅ / ✅ | ◐ user input 强；其他审批依赖 SDK | Apache-2.0；SDK 为 AGPL-3.0 | **可借审批/UI，依赖和私有 API 风险高** |
| [NathanZane/codex-mobile](https://github.com/NathanZane/codex-mobile) | Discord | ✅ | ✅ SQLite/cursors | ◐ cursor 去重；send→record 窗口仍在 | ✅ / ❌ | ✅ / ✅ | MIT | **模块化镜像/控制面参考；不是通用 bot core** |
| [HanifCarroll/codex-telegram-bridge](https://github.com/HanifCarroll/codex-telegram-bridge) | Telegram、Discord | ✅ | ✅ SQLite | ✅ durable outbox/retry；仍非数学 exactly-once | ❌ / ❌ | ❌：YES/NO 被发成新 turn | MIT | **可靠投递模式优秀，但 server request 语义不合格** |
| [heungtae/codex-telegram](https://github.com/heungtae/codex-telegram) | Telegram | ✅，per-thread process | ❌ mapping 仅内存 | ◐ | ❌ / ❌ | ◐ 按钮审批，通用文本输入弱 | Apache-2.0 | **仅适合借审批交互** |
| [imprisonedmind/codex-discord-bridge](https://github.com/imprisonedmind/codex-discord-bridge) | Discord | ✅ | ✅ JSON + pending turn snapshot | ◐ 重启只告警，不真正续订 active turn | ❌ / ◐ 参数与当前协议有偏差 | ◐ | 未发现 LICENSE | **状态/queue 思路可读，不可默认复制** |
| [yhdesai/codex-toolbox](https://github.com/yhdesai/codex-toolbox) | Telegram、Discord | ✅ | ✅ JSON | ◐ live + JSONL fallback | ✅ / ◐ 参数有漂移 | ◐ | 未发现 LICENSE | **覆盖广，但协议漂移和许可证阻断采用** |
| [pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server) | Telegram、Discord | ✅ | ✅ | ✅ | ✅ / ✅ | ✅ / ✅ | MIT | **功能强但必须依赖 OpenClaw；不符合独立边界** |
| [Openclaw-Metis/codex-discord-mcp](https://github.com/Openclaw-Metis/codex-discord-mcp) | Discord | ❌ `codex exec --json` | ◐ exec resume | ❌ 无持续 App Server stream | ❌ / ❌ | ❌ | MIT | **排除：表面像 bridge，实际是 CLI wrapper** |

所有“活跃度”只按 2026-08-26 观察到的 default-branch 最新 commit 判断，不等价于维护承诺。关键候选当日快照：`codex-tg` 为 `ec5f826…`，`codex-telegram-frontend` 为 `fb3b296…`，`codex-qq-bot` 为 `be09c76…`，`codex-slack` 为 `8817ccb…`，`codex-mobile` 为 `f79e680…`，Hanif bridge 为 `705da48…`。

## 4. 重点候选源码证据

### 4.1 `mideco-tech/codex-tg`：最佳控制面基材

这是本轮最接近目标“内核”的仓库，而不是最接近目标 channel 覆盖的仓库。

- control interface 已把生命周期、事件源、thread、turn 和 server request 拆开；直接调用 app-server，而不是 `codex exec`：[control.go@ec5f826](https://github.com/mideco-tech/codex-tg/blob/ec5f8265824b49a023fc3e664c1c4322e7ae611a/internal/control/control.go)、[appserver/client.go@ec5f826](https://github.com/mideco-tech/codex-tg/blob/ec5f8265824b49a023fc3e664c1c4322e7ae611a/internal/appserver/client.go)。
- SQLite 包含 thread binding、Telegram message/callback route、pending approval、delivery queue、attempt、thread snapshot、steer state；outbox 对 `(event_id, chat_key)` 有唯一性约束：[storage/store.go@ec5f826](https://github.com/mideco-tech/codex-tg/blob/ec5f8265824b49a023fc3e664c1c4322e7ae611a/internal/storage/store.go)。
- live notification 与 `thread/read` polling 被归一成统一事件，可用于断线/重启后的 final reconciliation：[normalize.go@ec5f826](https://github.com/mideco-tech/codex-tg/blob/ec5f8265824b49a023fc3e664c1c4322e7ae611a/internal/appserver/normalize.go)。

不足：只有 Telegram，Telegram route 仍进入 domain/storage 命名；需要先抽 `ChannelPort` 和 channel-neutral identity，不能直接在现有结构里不断加 QQ/WhatsApp `if` 分支。

判断：**借鉴/选择性 fork 核心模块**，不是整仓直接采用。

### 4.2 `codex-telegram-frontend`：当前协议覆盖最完整的轻量参考

- WebSocket live stream 有 reconnect、`thread/resume` 重新订阅和指数退避：[app-server-live.mjs@fb3b296](https://github.com/anton88vlc/codex-telegram-frontend/blob/fb3b296ab5675cd05449673f972bcc6c5852d751/lib/app-server-live.mjs#L12-L113)。
- native send 在同一连接上 resume、start、监听 `item/completed` 最终 agent message，并以匹配 turn 的 `turn/completed` 收口：[codex-native.mjs@fb3b296](https://github.com/anton88vlc/codex-telegram-frontend/blob/fb3b296ab5675cd05449673f972bcc6c5852d751/lib/codex-native.mjs#L130-L205)。
- `turn/steer` 使用 active turn 的 `expectedTurnId`，`turn/interrupt` 同时发送 `threadId`/`turnId`：[codex-controls.mjs@fb3b296](https://github.com/anton88vlc/codex-telegram-frontend/blob/fb3b296ab5675cd05449673f972bcc6c5852d751/lib/codex-controls.mjs#L176-L225)。
- command/file/permission approvals 与 `requestUserInput` 都有状态和回包路径：[app-server-stream.mjs@fb3b296](https://github.com/anton88vlc/codex-telegram-frontend/blob/fb3b296ab5675cd05449673f972bcc6c5852d751/lib/app-server-stream.mjs#L442-L486)、[app-server-approvals.mjs@fb3b296](https://github.com/anton88vlc/codex-telegram-frontend/blob/fb3b296ab5675cd05449673f972bcc6c5852d751/lib/app-server-approvals.mjs#L422-L468)。
- binding、processed message keys、outbound mirror 状态用临时文件 + rename 原子写：[state.mjs@fb3b296](https://github.com/anton88vlc/codex-telegram-frontend/blob/fb3b296ab5675cd05449673f972bcc6c5852d751/lib/state.mjs#L1-L54)。

不足：JSON state 不是 durable transactional outbox；直播队列有内存上限；它同时承担 Desktop mirror/reconciliation，结构比纯 bridge core 更复杂。

判断：**借协议处理和 Telegram UX，不直接 fork 为多 channel 基座。**

### 4.3 `codex-qq-bot`：最接近 QQ，但许可证和生命周期阻断采用

- 直接启动 `codex app-server --stdio` 并实现 JSON-RPC request/response：[codex-app-server-turn.js@be09c76](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L60-L179)。
- 能 resume thread，失败后 start，新 turn 流程完整：[同文件](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L563-L658)。
- 能 steer、interrupt 后 replacement，并按匹配 thread/turn 的 completion 收敛最终答复：[同文件](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L420-L515)、[item handling](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L197-L273)。
- OneBot ingress 能解析 private/group/mention/image/file，并有短 TTL event dedupe：[onebot-event.js@be09c76](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/channels/qq/onebot-event.js#L1-L183)。

关键风险：

1. 每 turn 启一个 App Server 进程，不是共享长连接；active approval 和断线恢复更脆弱；
2. event dedupe 与 delivery receipt 不是事务 inbox/outbox，进程在“平台发送成功”和“本地记录成功”之间崩溃仍可能重复；
3. 未发现仓库根 LICENSE。没有许可证不代表 MIT；默认版权状态下不能假定允许复制或分叉；
4. 接入是 OneBot/NapCat 路线，不是腾讯官方 QQ Bot API，部署和合规风险不同；
5. 没有 WhatsApp。

判断：**可用于理解 QQ 产品行为；除非作者补许可证/授权，不作为代码基座。**

### 4.4 其他可借模式

两个 MIT 小型项目适合做协议测试夹具，而不是生产底座。`Gan-Xing/telegram-codex-app-bridge` 集中了 thread start/resume、turn start/steer/interrupt、server-request 分流与 response：[client.ts@3cf5cbd](https://github.com/Gan-Xing/telegram-codex-app-bridge/blob/3cf5cbddd8de26283b37f4b8c879242751ddf042/src/codex_app/client.ts#L185-L309)、[request dispatch](https://github.com/Gan-Xing/telegram-codex-app-bridge/blob/3cf5cbddd8de26283b37f4b8c879242751ddf042/src/codex_app/client.ts#L462-L473)。`codenoah/codex-telegram-bridge` 把 WebSocket App Server lifecycle 和 command/file/permission approval 映射集中在单文件，便于做最小互操作测试：[bridge.ts@47a1c80](https://github.com/codenoah/codex-telegram-bridge/blob/47a1c80d2a56675a75eea61772eefa3d3e6a6da9/src/bridge.ts#L220-L265)、[approval mapping](https://github.com/codenoah/codex-telegram-bridge/blob/47a1c80d2a56675a75eea61772eefa3d3e6a6da9/src/bridge.ts#L736-L800)。两者的可靠存储、并发和多 channel 能力仍不足，因此适合借 typed fixtures/协议分流，不适合直接承载目标系统。

`panzhang83/codex-slack` 的优点是 Slack thread/session store、媒体输入、任意文本 user-input、steer/interrupt 都较完整：[app_runtime.py@8817ccb](https://github.com/panzhang83/codex-slack/blob/8817ccb7aadc3acc449405861253b88b475f9916/app_runtime.py#L254-L429)、[turn loop](https://github.com/panzhang83/codex-slack/blob/8817ccb7aadc3acc449405861253b88b475f9916/app_runtime.py#L586-L744)。但它依赖社区 `codex-app-server-sdk`，并调用其私有成员；该 SDK 的 PyPI 元数据是 AGPL-3.0，而非 OpenAI 官方 SDK：[PyPI](https://pypi.org/project/codex-app-server-sdk/)。因此仅借交互模式。

`HanifCarroll/codex-telegram-bridge` 有本轮最清晰的 SQLite outbox、transport delivery log、retry/backoff：[state.rs@705da48](https://github.com/HanifCarroll/codex-telegram-bridge/blob/705da48ea4dc0657c0dd9b823ce8779f0372d662/src/state.rs#L1633-L1775)、[daemon.rs@705da48](https://github.com/HanifCarroll/codex-telegram-bridge/blob/705da48ea4dc0657c0dd9b823ce8779f0372d662/src/daemon.rs#L119-L179)。但 approval callback 实际创建新 turn 发送 `YES`/`NO`，没有回答原 App Server request：[telegram.rs@705da48](https://github.com/HanifCarroll/codex-telegram-bridge/blob/705da48ea4dc0657c0dd9b823ce8779f0372d662/src/telegram.rs#L778-L839)。只借 outbox，不借审批模型。

`NathanZane/codex-mobile` 是 Discord notification/control surface，SQLite cursor、bridge service/provider 分层和 server-request routing 很有参考价值：[CodexAdapter.ts@f79e680](https://github.com/NathanZane/codex-mobile/blob/f79e6807ca0b9d6052afd24f822ee41b9a52e07d/src/codex/CodexAdapter.ts#L51-L195)、[BridgeService.ts@f79e680](https://github.com/NathanZane/codex-mobile/blob/f79e6807ca0b9d6052afd24f822ee41b9a52e07d/src/bridge/BridgeService.ts)。但它更偏 Desktop/CLI mirror，未实现 interrupt，也没有 QQ/WhatsApp。

## 5. Channel adapter 候选

### 5.1 QQ：优先腾讯官方 SDK，不以 OneBot 作为唯一实现

[tencent-connect/qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs) 来自腾讯官方 GitHub org，MIT，源码包含 Gateway/Webhook transport、token/retry、C2C/group/media 和 session persistence port：

- [Gateway connection@ca55d9c](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/gateway-connection.ts)
- [Webhook transport@ca55d9c](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/transport/webhook.ts)
- [Media API@ca55d9c](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/media.ts)

但其 message filter 去重只有短时内存状态，session adapter 也不是 bridge 需要的事务存储：[message-filter.ts@ca55d9c](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/middleware/message-filter.ts)、[session-adapter.ts@ca55d9c](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/storage/session-adapter.ts)。因此 durable inbox/mapping/outbox 必须归 bridge core 所有。

建议同时保留 OneBot adapter 作为可插拔兼容层，但在产品和文档上明确标注“腾讯官方 QQ Bot”与“非官方 QQ 客户端/OneBot”两种运行模式，不混为一种安全与合规承诺。

### 5.2 WhatsApp：先作产品选择

生产/官方路线可采用 [vercel/chat](https://github.com/vercel/chat) 的 WhatsApp Business Cloud adapter。它已经有统一 Adapter/Thread/Message/State 类型，并提供 Telegram、Slack、Discord、WhatsApp adapter：[types.ts@50af160](https://github.com/vercel/chat/blob/50af1605d5405dc9b23108e2536fa62fc758640c/packages/chat/src/types.ts)。WhatsApp adapter 实现 webhook HMAC-SHA256 验签、媒体上传/下载和模板消息：[adapter-whatsapp@50af160](https://github.com/vercel/chat/blob/50af1605d5405dc9b23108e2536fa62fc758640c/packages/adapter-whatsapp/src/index.ts)。限制是 WhatsApp Business Cloud 的 1:1 business messaging，不是个人号/群聊。

若需求是个人号/群聊，常见开源路线是 [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)，但它是 WhatsApp Web 协议实现，不是 Meta 官方 Cloud API；生产 auth state 必须自行持久化，且需用户显式接受 ToS/封号风险。其仓库自己也提示不要把 multi-file auth state 当生产方案：[README@0af2386](https://github.com/WhiskeySockets/Baileys/blob/0af2386292907f7d9742d8d41f830d8c48208fa1/README.md)、[use-multi-file-auth-state.ts@0af2386](https://github.com/WhiskeySockets/Baileys/blob/0af2386292907f7d9742d8d41f830d8c48208fa1/src/Utils/use-multi-file-auth-state.ts)。

Vercel Chat 可作为 adapter 层参考/依赖，但不应让它独自管理 Codex 长 turn 并发；其 handler lock TTL 为 30 秒，长 turn 可能在锁过期后并发进入。应由自有 mailbox/lease heartbeat 管理 turn serialization：[chat.ts@50af160](https://github.com/vercel/chat/blob/50af1605d5405dc9b23108e2536fa62fc758640c/packages/chat/src/chat.ts)、[issue #685](https://github.com/vercel/chat/issues/685)。

## 6. 明确排除的“表面匹配”

- `Openclaw-Metis/codex-discord-mcp` 实际执行 `codex exec --json`，不是 App Server：[codex.ts@6d0813b](https://github.com/Openclaw-Metis/codex-discord-mcp/blob/6d0813bfce26ffedf0a0d090802113fbe57e6754/src/codex.ts#L127-L204)。
- `amintikk/codex-telegram`、`gitdefi/ClaudeCode-Codex_telegram-bridge`、`happy-shine/opencodex`、`Mark-Life/telegram-claude-codex` 都属于 `codex exec`/resume wrapper；能保留 thread continuity，但没有持续 App Server event stream、server→client requests 和原生 steer 生命周期。
- `pwrdrvr/openclaw-codex-app-server` 虽然协议覆盖好，但源码直接 import OpenClaw plugin SDK/account/state，运行时边界仍是 OpenClaw plugin，不符合“不依赖外部 gateway 管理”。
- LangBot、AstrBot、OpenClaw 等多 channel agent framework 本身就是另一层 gateway/agent runtime；即使 adapter 多，也偏离本仓库要建立的独立边界。

## 7. 缺口与风险

1. **没有可宣称严格 exactly-once 的候选。** provider API 通常只能做到 at-least-once webhook + client-side dedupe。可实现的是“effectively-once final delivery”：`inbox(provider_event_id UNIQUE)`、`turn(clientUserMessageId UNIQUE)`、`outbox(channel, target, logical_item_id UNIQUE)`、发送状态和 reconciliation；发送成功后进程在落库前崩溃的窗口仍需 provider idempotency key 或内容/receipt reconciliation。
2. **App Server server request 属于连接所有权。** 若每 turn 启停进程，或多个 client 同时 resume 同一 active thread，approval/requestUserInput 可能没有正确的 owner。核心应长期持有连接，并保存 `requestId → channel target → connection generation`。
3. **协议快速漂移。** 一些仓库的 `turn/interrupt` 只传 `threadId`，已与当前官方协议不一致；不要封装成散落在 adapter 中的 JSON，应有集中 typed protocol client 和兼容测试。
4. **重连不等于恢复。** reconnect 后要 resume/subscribe、`thread/read` reconcile、重建 active turn state、重投 pending outbox；单纯重新 spawn process 不够。
5. **审批安全。** command/file/permission/user-input 必须区分类型、展示 cwd/风险、鉴权 callback 用户，并使用 deny-by-default timeout。不能把任意 `YES` 当作另一个 user turn。
6. **媒体安全。** 限制 MIME/大小/下载超时，使用随机临时路径，防止路径穿越和 SSRF；远程媒体要先下载，再用 data URL/`localImage` 传给 App Server。
7. **QQ 两套生态。** 官方 Bot API 与 OneBot/NapCat 的能力、账号类型、合规和稳定性不同，必须是两个 adapter，而不是通过配置偷换协议。
8. **WhatsApp 两套生态。** Business Cloud 与 WhatsApp Web/个人号的能力和风险不同，需在编码前做产品决策。
9. **无许可证仓库。** `codex-qq-bot`、`codex-toolbox`、`codex-discord-bridge`、`vruru/telegram_codex_bridge` 本次未发现根 LICENSE；只可观察公开源码，不能据此推定有权复制。

## 8. 推荐决策

### 推荐：Build core，borrow/fork patterns；不要整仓 adopt

建议 TypeScript 路线：

1. 自建 `codex-channel-bridge` 独立仓库和进程，不引用 Hermes/OpenClaw runtime；
2. `CodexControlPlane` 直接长期连接 `codex app-server`，接口设计借 `codex-tg`；
3. 自有 SQLite/Postgres 存 `channel_identity`、`thread_binding`、`active_turn`、`server_request`、`inbox`、`outbox`、`delivery_attempt`；
4. QQ 官方 adapter 采用 `tencent-connect/qqbot-nodejs`；另做可卸载 OneBot adapter；
5. WhatsApp Business Cloud/Telegram/Slack/Discord 可评估 Vercel Chat adapters，但 turn mailbox、lock、outbox 必须归 bridge core；
6. 从 `codex-telegram-frontend` 借 typed event/request 归一化和 Telegram approval UX，从 Hanif bridge/codex-tg 借 outbox/reconciliation；
7. 第一阶段先做 QQ + 一个容易验证的 Telegram adapter，把协议和可靠性测通；WhatsApp 先确定 Business Cloud 还是个人号/群聊，再实现。

若团队坚定选择 Go，最短路径是 fork `mideco-tech/codex-tg`，先把 Telegram-specific storage/domain 抽成 `ChannelPort`，再实现 QQ 和 WhatsApp；但多 channel adapter 生态明显弱于 TypeScript 路线。

在任何 fork 前还需逐项做许可证兼容评审；尤其不要把无 LICENSE 项目或 AGPL SDK 的代码无意带入目标仓库。

## 9. 搜索覆盖与不确定性

本次覆盖：

- GitHub 搜索组合：`codex app-server` + `QQ` / `OneBot` / `WhatsApp` / `Telegram` / `Slack` / `Discord`，以及 `thread/start`、`turn/steer`、`requestUserInput` 等代码特征；
- 逐仓源码核验：`codex-qq-bot`、`codex-tg`、`codex-telegram-frontend`、Gan-Xing bridge、codenoah bridge、`codex-telegram`、`codex-discord-bridge`、`codex-toolbox`、`codex-slack`、Hanif bridge、NathanZane `codex-mobile`、OpenClaw plugin、`codex-discord-mcp`；
- channel 框架/SDK：Vercel Chat、腾讯 `qqbot-nodejs`/`qqbot-agent-sdk`、Baileys、Satori；
- 官方/第一方来源：OpenAI Codex app-server repo/docs/issues、腾讯官方 GitHub org、各候选仓库 source/license；
- 判断没有只依赖 README：核心结论至少核对了 process spawn、RPC methods、state schema、server-request handler、delivery/retry 或许可证文件。

未覆盖或仍不确定：私有仓库、未被 GitHub 索引的近期项目、非 GitHub forge、各平台后台的账户准入/地区限制、候选在真实高并发和断电窗口下的行为、未来 Codex 协议兼容性。星标数和最近 commit 只能提示活跃度，不能证明安全性或生产成熟度。
