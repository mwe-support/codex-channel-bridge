# 三个 QQ ↔ Codex 仓库的当前实现对比

- 调研日期：2026-08-28（Asia/Shanghai）
- 对比对象：
  - [`983033995/qq-codex-bridge`](https://github.com/983033995/qq-codex-bridge)
  - [`gl813788-byte/codex-qq-bot`](https://github.com/gl813788-byte/codex-qq-bot)
  - [`uniqueFranky/Codex-QQBot`](https://github.com/uniqueFranky/Codex-QQBot)
- 方法：克隆默认分支，固定到 commit 后逐项阅读源码、package manifest、部署文件和测试配置；README 仅用于核对产品声明，不替代源码证据。
- 说明：下文的“可靠投递”特指有持久 inbox/outbox、状态迁移、重试与重启 reconciliation 的实现；单次 HTTP 成功、内存去重或普通日志不等于可靠投递。

## 1. 结论先行

三个仓库不是同一种实现的不同版本，而是三条明显不同的路线：

1. **`qq-codex-bridge` 是桥接架构最清晰、最接近“官方 QQ Bot + 直接 Codex App Server”的实现。** 它有 channel/domain/orchestrator/store 分层、官方 QQ Gateway、SQLite 会话映射和长驻 App Server WebSocket client；但当前 App Server 握手未发送 `initialized`，所有 server-initiated request 都统一返回 `-32601`，`delivery_jobs` 也只有 pending 插入而没有状态更新、重试或重启投递。因此它是一个结构较好的原型，不是已经闭环的可靠 Bridge。[默认 App Server 装配](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/apps/bridge-daemon/src/bootstrap.ts#L61-L88)；[握手实现](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L468-L487)；[server request 处理](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L610-L650)；[`delivery_jobs` 写入](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/store/src/message-repo.ts#L31-L39)。
2. **`codex-qq-bot` 是 QQ 产品能力和 Codex 原生控制覆盖最广的实现。** 它通过 OneBot/NapCat 接入 QQ，每次任务启动一个 `codex app-server --stdio` 子进程，支持 thread resume、native steer、interrupt/replacement、动态工具、分 scope 会话、权限角色、记忆和主动交互。但它不是腾讯官方 QQ Bot 协议路线；App Server 审批默认拒绝且主 QQ turn 没有传入审批 UI handler；去重只在内存，发送回执也没有事务 outbox。它更像“本地 QQ Agent Hub”，不是窄 Channel Bridge。[每任务启动 App Server](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L9-L68)；[steer/restart](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L420-L487)；[OneBot 归一化](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/channels/qq/onebot-event.js#L6-L65)。
3. **`Codex-QQBot` 是最小、最容易理解的 Docker 封装，但它不是 App Server bridge。** 它手写腾讯官方 QQ Bot Gateway/C2C API，收到消息后执行 `codex exec --json` 或 `codex exec resume`；全局只有一个 `threadId` 和一个消息队列，没有 openid ACL、inbound dedupe 或 outbox。默认 Docker 还以 `danger-full-access` 运行 Codex，并在构建时查询和安装当时的 latest Codex 版本。这个实现适合阅读最小链路，不适合多用户或需要隔离、审批和可靠性的部署。[Codex CLI 参数](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/codex/runner.ts#L160-L204)；[全局状态](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/state.ts#L3-L20)；[Docker Codex 安装](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/Dockerfile#L91-L112)。

**共同结论：三个仓库都没有完整实现“持久 inbound 去重 + Codex input correlation + durable outbox + provider receipt/retry + 重启 reconciliation + 原请求审批回传”的闭环。** `qq-codex-bridge` 的骨架最像 bridge，`codex-qq-bot` 的 QQ/Codex 交互面最丰富，`Codex-QQBot` 最小但边界最弱；这些是实现形态判断，不代表仓库的维护承诺。

## 2. 固定快照

| 仓库 | 本次固定 commit | 默认分支 | manifest 版本 | 最近提交时间 | 许可证 |
|---|---|---|---|---|---|
| `983033995/qq-codex-bridge` | [`ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a`](https://github.com/983033995/qq-codex-bridge/commit/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a) | `main` | `0.1.4` | 2026-04-26 | MIT，[LICENSE](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/LICENSE#L1-L20) |
| `gl813788-byte/codex-qq-bot` | [`be09c76954e66ed10936fd3f114a565448bcd869`](https://github.com/gl813788-byte/codex-qq-bot/commit/be09c76954e66ed10936fd3f114a565448bcd869) | `main` | `1.1.9` | 2026-08-26 | 本快照根目录及 manifest 未发现 LICENSE；不能据此推定可复制或分叉。[固定树](https://github.com/gl813788-byte/codex-qq-bot/tree/be09c76954e66ed10936fd3f114a565448bcd869)；[package.json](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/package.json#L1-L46) |
| `uniqueFranky/Codex-QQBot` | [`fb47a9f7c497fa2dbb743023934a431db42743be`](https://github.com/uniqueFranky/Codex-QQBot/commit/fb47a9f7c497fa2dbb743023934a431db42743be) | `master` | `0.1.0` | 2026-05-11 | MIT，[LICENSE](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/LICENSE#L1-L20) |

仓库会继续变化；所有“有/没有”的判断都只针对上述 commit。

## 3. 总览矩阵

| 维度 | `qq-codex-bridge` | `codex-qq-bot` | `Codex-QQBot` |
|---|---|---|---|
| QQ 接入 | 腾讯官方 Bot API/Gateway，手写 client；C2C + group；多 Bot | OneBot HTTP webhook/API，通常由 NapCat/LLBot 提供；私聊 + 群聊 | 腾讯官方 Bot API/Gateway，手写 client；只处理 C2C |
| Codex 接入 | 默认长驻 `codex app-server --listen ws://127.0.0.1:*`；可外接 URL；保留 Codex Desktop CDP/DOM fallback | 每任务一个 `codex app-server --stdio`；结束后终止子进程 | 每任务 `codex exec --json`，有 thread 时使用 `exec resume` |
| 会话映射 | SQLite：`account + chat type + peer → thread ref` | JSON：scope → thread，temporary / persistent / auto | 一个全局 current thread + 可命名 thread map，不按 openid 隔离 |
| 并发 | 同 session 串行；App Server 路径可跨 session 并发；DOM 路径全局串行 | 全局 Codex limiter 默认 2 active / 32 pending；每 scope 有 follow-up fusion/steer | 单 active run；其余进入一个全局 FIFO |
| 审批 / user input | 全部 server request 回 `-32601` | 支持 handler 扩展点，但普通 QQ turn 未装 handler；默认 decline / 空答案 | `-a never` 或完全 bypass，无 App Server server request 通道 |
| inbound 去重 | SQLite 按 provider message id；另有 90 秒内存指纹 | 10 分钟 / 10,000 项内存 Map | 无 |
| durable outbox | 有 `delivery_jobs` 表名，但只有 pending INSERT，无状态机/重试 worker | 无；记录 send result/失败内容供下一轮参考 | 无 |
| 部署 | Node/pnpm，本机运行；有 CI；无原生 service/Docker 基线 | Node，本地 Hub + OneBot，跨 macOS/Linux/WSL/Termux 安装器 | Docker Compose，单容器运行 QQBot + Codex |
| 最突出的风险 | App Server 握手不完整、审批缺失、伪 outbox、首绑 latest thread | 非官方 QQ 客户端路线、per-turn App Server、复杂度高、无许可证 | 无 ACL、多用户共享上下文、无去重、全权限、Codex 未固定版本 |

## 4. `983033995/qq-codex-bridge`

### 4.1 架构与 QQ 接入

代码已经按 `apps`、channel adapters、domain、orchestrator、ports、store 拆分；manifest 使用 Node ≥20、`better-sqlite3`、`ws`、`zod`，说明它是一个 TypeScript 本地 daemon，而不是 QQ 插件。[package.json](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/package.json#L1-L65)

QQ adapter 没有依赖腾讯 SDK，而是直接实现 token、Gateway discovery、WebSocket、heartbeat、identify/resume 和 C2C/group REST send。Gateway intents 包含 group/C2C，dispatch 处理 `C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`、`GROUP_MESSAGE_CREATE`；关闭码有退避、限流延迟和 session 失效处理。[Gateway intents 与生命周期](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/qq/src/qq-gateway-client.ts#L7-L77)；[identify/resume](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/qq/src/qq-gateway-client.ts#L200-L231)；[dispatch 类型](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/qq/src/qq-gateway-client.ts#L234-L269)；[重连策略](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/qq/src/qq-gateway-client.ts#L292-L346)

C2C session key 使用 user openid，group session key 使用 group openid；group 内不同成员共享一个 Codex session，但消息仍保留 member openid 作为 sender。这是“按对话隔离”，不是“按群成员隔离”。[C2C 归一化](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/qq/src/qq-normalizer.ts#L4-L29)；[group 归一化](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/qq/src/qq-normalizer.ts#L32-L58)

它支持多个 QQ Bot account，每个 account 有独立 API client 和 Gateway session 文件；所有 account 共用一个 SQLite 和一个 Codex driver。[多 Bot 装配](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/apps/bridge-daemon/src/bootstrap.ts#L89-L121)

### 4.2 Codex 接入：默认 App Server，但握手不完整

当前默认不是 README 早期描述的纯 CDP 路线：只有 `CODEX_DESKTOP_TRANSPORT=dom` 才使用 legacy DOM driver；否则创建 `CodexAppServerDriver`，DOM driver 只保留为控制 fallback。[bootstrap](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/apps/bridge-daemon/src/bootstrap.ts#L61-L88)

App Server driver 默认启动一个长驻子进程，监听随机的本机 WebSocket 端口；同一个 daemon 内的 session 共享这条 App Server connection。它用 `thread/start`、`thread/resume`、`turn/start`，从 `item/agentMessage/delta`、`item/completed` 收集内容，并以 `turn/completed` 收口；超时会发 `turn/interrupt`。[启动与连接](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L502-L581)；[turn start](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L370-L402)；[事件收口](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L653-L725)

但连接握手只发送 `initialize`，收到响应后直接把本地标志设为 `initialized=true`；源码没有发送 `initialized` notification。也就是说，变量名“initialized”不等于协议第二步真的发出。[握手源码](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L468-L487)

它没有 `turn/steer` 的业务路径。收到新消息时会先读取 thread，只有发现超时阈值以上的 stale in-progress turn 才 interrupt，再启动新 turn；这与“把正常 follow-up steer 进 active turn”不同。[新消息流程](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L370-L402)；[stale interrupt](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L839-L865)

### 4.3 会话与并发

SQLite 的 `bridge_sessions` 持久化 thread ref 和 last turn，`message_ledger.message_id` 是主键；同 session 通过进程内 promise tail 串行。数据库中的 `session_locks` 行只是当前进程临界区的记录：进入前先无条件删除旧行，再插入新 owner，没有跨进程租约竞争语义。[schema](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/store/src/sqlite.ts#L25-L69)；[session lock](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/store/src/session-repo.ts#L99-L135)

App Server 路径没有全局 turn lock，因此不同 session 可并行；DOM transport 才走 daemon 级串行 lock。[turn lock 选择](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/apps/bridge-daemon/src/bootstrap.ts#L122-L147)

一个容易遗漏的行为是：**全新 Bridge session 没有 binding 时，driver 会先取 App Server 的 latest thread 并绑定它；只有完全没有 thread 时才新建。** 因此“SQLite 中每个 QQ session 有独立 binding 槽位”不等于“首次消息一定创建独立 Codex thread”；多个新 session 可能先绑定同一个 latest thread，直到用户执行 thread 管理命令。[openOrBindSession](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L270-L299)

### 4.4 权限审批

App Server 发来的带 `id` request 会统一收到 JSON-RPC `-32601`，消息是 `qq-codex-bridge does not handle server requests yet`。因此 command/file/permission approval、`requestUserInput`、MCP elicitation 都没有 QQ 展示、参与者鉴权和回到原 request 的路径。[request 分流](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/codex-desktop/src/codex-app-server-driver.ts#L610-L650)

QQ ingress 也没有看到 allowlist、owner/admin 或私聊/群聊 access policy；被 QQ 平台投递到 bot 的 C2C/group message 会直接进入 thread command handler 或 orchestrator。[ingress dispatch](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/apps/bridge-daemon/src/main.ts#L62-L110)；[启动 QQ handlers](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/apps/bridge-daemon/src/main.ts#L143-L154)

### 4.5 持久化与投递

inbound 先按 `message_id` 查询并在 session lock 内复查，再 `INSERT OR IGNORE` 到 `message_ledger`，所以进程重启后的 provider-id 重复能被抑制；此外还有 90 秒内容指纹 Map，用来压制 provider id 不同但内容相同的近邻重复。[orchestrator 去重](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/orchestrator/src/bridge-orchestrator.ts#L45-L87)；[指纹窗口](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/orchestrator/src/bridge-orchestrator.ts#L223-L271)；[ledger insert](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/store/src/message-repo.ts#L10-L44)

`delivery_jobs` 表有 `status`、`attempt_count`、`last_error`，但当前 repository 只执行 `INSERT OR IGNORE ... status='pending', attempt_count=0`。对完整源码搜索没有找到 `UPDATE delivery_jobs`、重试 worker 或启动时 pending reconciliation；发送成功也不写 provider receipt。调用顺序是“先记录 pending，再直接 send”，失败仅写日志并把错误放到 session 状态。[delivery schema](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/store/src/sqlite.ts#L52-L61)；[唯一写入](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/store/src/message-repo.ts#L31-L39)；[记录后直发](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/orchestrator/src/bridge-orchestrator.ts#L89-L132)

QQ Gateway 的 seq 在业务 dispatch 之前就写 session 文件；如果 seq 已持久化后进程在 ledger commit 前崩溃，resume 可能从更后的 seq 开始。这是由代码顺序推导出的 crash window，而不是已实测的数据丢失。[先更新 seq](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/qq/src/qq-gateway-client.ts#L161-L180)；[后业务 dispatch](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/packages/adapters/qq/src/qq-gateway-client.ts#L234-L268)

### 4.6 部署与成熟度

项目有 pnpm lock、39 个测试文件和 GitHub Actions，CI 执行 typecheck 与 Vitest；发布版为 `0.1.4`。这表明它有工程化基线，但当前仓库没有 native service、Docker、schema migration、支持 bundle 或真实 provider acceptance 证据，不能从 CI 推导生产成熟度。[CI](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/.github/workflows/ci.yml#L1-L36)；[manifest scripts](https://github.com/983033995/qq-codex-bridge/blob/ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a/package.json#L35-L64)

## 5. `gl813788-byte/codex-qq-bot`

### 5.1 架构与 QQ 接入

它的 composition root 是超过一万行的 `src/server.js`，同时已有大量 focused modules；仓库自己的架构文档也把 `server.js` 定义为仍在拆分的 transitional legacy orchestration。产品范围包括 dashboard、QQ 社交动作、主动聊天、分层记忆、文件任务和动态工具，明显大于 Channel Bridge。[架构模块表](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/docs/ARCHITECTURE.md#L24-L71)

QQ 不是腾讯官方 Bot Gateway，而是 HTTP Hub 接收 OneBot event，再调用 OneBot API；安装器会按平台选择或复用 NapCat/LLBot。归一化支持 group/private、@、reply、图片、文件、poke 等事件。[OneBot event](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/channels/qq/onebot-event.js#L6-L65)；[HTTP adapter](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/channels/http/hub-http-server.js#L1-L35)；[安装说明](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/README.md#L21-L41)

### 5.2 Codex 接入：每任务 App Server

每次 `runCodexAppServerTurn()` 都 spawn `codex app-server --stdio`；turn 完成、失败、超时或 abort 后发送 SIGTERM，超出 grace 再 SIGKILL。也就是说它通过 thread ID 恢复 Codex 状态，但不保留跨任务的 App Server 进程/connection generation。[spawn](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L9-L68)；[终止生命周期](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L93-L155)

握手正确执行 `initialize` 后发送 `initialized`；有 thread ID 时 `thread/resume`，stale thread 才 fallback 到 `thread/start`，随后 `turn/start`。[initialize/initialized](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L563-L579)；[resume/start](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L580-L649)

active turn 支持 `turn/steer`；steer 失败时可 `turn/interrupt` 并启动 replacement turn，follow-up coordinator 还会核对 generation identity 后才消费 pending entries。[steer/restart](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L420-L487)；[follow-up coordinator](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/qq-reply-steering.js#L63-L126)

### 5.3 会话与并发

会话按 QQ scope 保存，可配置 `temporary`、`persistent`、`auto`；auto 会按已有 fresh thread 和近期交互频率决定是否持久化，最多保留 64 个 scope-thread 映射。[session modes](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/qq-codex-session.js#L1-L68)；[auto 规则](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/qq-codex-session.js#L70-L111)

映射写入 `qq-codex-sessions.json`，使用 coalescing writer、同路径串行、临时文件、fsync、rename 和目录 sync；它只保存 Bridge-side thread mapping，不复制 Codex history。[session writer](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/server.js#L2557-L2584)；[atomic write](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/file-store.js#L29-L67)

全局 Codex limiter 默认 2 active、32 pending，OneBot webhook limiter 默认 8 active、32 pending；pending queue 有上限和 abort/close 语义。具体 QQ follow-up 另有按 scope scheduler，避免同 scope 的 active generation 被错误替换。[环境默认值](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/config/environment.js#L10-L29)；[limiter](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/concurrency-limiter.js#L1-L118)；[实例化](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/server.js#L800-L840)

### 5.4 权限审批

Hub 层有 owner、administrator、allowed groups、command permissions 和 bans。OneBot webhook 在配置 token 时要求 constant-time token 验证；无 token 时只接受 loopback。非 loopback Hub binding 还要求显式开关和 API token。[settings shape](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/config/settings.example.json#L4-L73)；[token compare](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/request-auth.js#L1-L24)；[OneBot request gate](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/server.js#L12980-L13024)；[binding fail-closed](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/server.js#L13595-L13608)

App Server client 有通用 `onServerRequest` 扩展点，但普通 QQ reply/file turn 的调用只传 `onDynamicToolCall` 和 `onProgress`，没有传 `onServerRequest`。默认 command/file approval 是 `decline`，permission approval 返回空权限，`requestUserInput` 返回空 answers，MCP elicitation 也 decline；因此没有把这些 Codex request 展示到 QQ、绑定原参与者再回包的 UI。[server request dispatcher](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L292-L321)；[默认拒绝](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-app-server-turn.js#L745-L754)；[普通 reply turn 参数](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/server.js#L9044-L9073)；[file turn 参数](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/server.js#L9693-L9716)

子进程环境使用 allowlist，只保留 Codex runtime/auth、locale、proxy 和显式 override，能避免把 Hub 的其他 secret 全量传给 Codex child。[isolated env](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/codex-child-env.js#L4-L47)

### 5.5 去重与投递

OneBot dedupe 是一个进程内 Map，默认 TTL 10 分钟、最多 10,000 项；进程重启后清空。HTTP 收到 event 后先在这个 Map 中 remember，再开始异步 QQ 处理，没有持久 inbox transaction。[deduplicator](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/channels/qq/onebot-event.js#L142-L183)；[webhook 使用](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/server.js#L13527-L13567)

发送后会把每个 bubble 分类为 delivered/failed，并只把 delivered 文本写入记忆；失败内容会进入下一轮模型上下文。这是有价值的“投递事实”模型，但不是 durable outbox：发送前没有事务记录，失败后没有自动重试队列，进程在 provider send 与 memory save 之间崩溃也无法 reconciliation。[receipt model](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/qq-delivery-receipt.js#L1-L65)；[send 后处理](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/src/server.js#L10950-L11045)

### 5.6 部署与成熟度

它是三者中功能面和测试面最大的：manifest 定义 `npm run check`、`node --test` 和 `verify`，本快照有 96 个 test 文件。2026-08-28 在当前受限 macOS sandbox 直接运行 `node --test` 得到 449 tests、439 pass、10 fail；失败包含 sandbox 禁止写 `~/.local/bin`/监听 loopback、macOS `/private/var` 路径别名，以及安装脚本在本环境中的编码/变量问题。因此这次结果证明大量纯逻辑测试可运行，但不能宣称当前 checkout 在所有目标环境全绿。[test scripts](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/package.json#L35-L46)；[代表性的 App Server tests](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/test/codex-app-server-turn.test.js)

它有跨 macOS/Linux/WSL/Termux 的安装器，并会准备 Node、Codex、OneBot 和项目依赖。易用性较强，但这也意味着安装器可能修改宿主环境，而且源码默认分支更新与平台组合增加了运维变量。[installer contract](https://github.com/gl813788-byte/codex-qq-bot/blob/be09c76954e66ed10936fd3f114a565448bcd869/install.sh#L42-L77)

最大的采用阻断是本快照未发现 LICENSE；其次是 OneBot/NapCat 不是腾讯官方 Bot API，账号能力、合规和稳定性边界不能与官方 Bot 混同。

## 6. `uniqueFranky/Codex-QQBot`

### 6.1 架构与 QQ 接入

这是 18 个 TypeScript source files 的小型单进程应用：composition root 只装配 config、JSON state、QQ auth/messages/gateway、Codex runner 和 controller。[composition root](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/index.ts#L1-L32)；[package manifest](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/package.json#L1-L18)

QQ 接入直接调用腾讯 Bot token endpoint 和 `/gateway/bot`，Gateway 只处理 `C2C_MESSAGE_CREATE`；支持 session resume、heartbeat 和固定 3 秒 reconnect。它请求了 group/C2C intent，但代码对 group dispatch 直接忽略，所以产品事实仍是“只支持私聊”。[auth](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/qq/auth.ts#L10-L39)；[Gateway lifecycle](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/qq/gateway.ts#L40-L91)；[只处理 C2C](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/qq/gateway.ts#L123-L140)；[resume/reconnect](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/qq/gateway.ts#L142-L202)

### 6.2 Codex 接入：CLI wrapper，不是 App Server

每个任务 spawn `codex` CLI，使用 `exec --json`；有 thread ID 时追加 `resume <threadId>`。它解析 CLI JSONL 的 `thread.started` 和 `agent_message`，超时或 `/stop` 直接 SIGTERM/SIGKILL 子进程。没有持续 App Server notification、server request、native `turn/steer` 或 `turn/interrupt`。[runner](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/codex/runner.ts#L40-L158)；[CLI args](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/codex/runner.ts#L160-L204)

`/interrupt` 的语义也是 kill 当前 `codex exec`，然后马上启动另一进程；它不是在同一个 active turn 上调用 App Server steer。[controller interrupt](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/app/controller.ts#L243-L255)

### 6.3 全局共享会话和队列

`state.json` 只有一个顶层 `threadId`、一个 `messageQueue`、一个 `lastOpenid`；controller 收到任何私聊都会覆盖 `lastOpenid`，并使用同一个 current thread。命名 session 只是 name → threadId map，也不是 openid → threadId map。[state shape](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/state.ts#L3-L20)；[覆盖 lastOpenid 与全局命令](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/app/controller.ts#L20-L139)；[命名 session](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/app/controller.ts#L496-L543)

只有一个 active Codex run。运行中收到的普通文本加入全局 FIFO；队列项只保存文本、不保存来源 openid，drain 时使用触发 drain 的 `context` 回包。多个发送者并发时会共享上下文、队列和回包目标，存在明显的跨用户串线风险。[入队](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/app/controller.ts#L123-L138)；[全局 queue 操作](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/app/controller.ts#L257-L304)

### 6.4 权限与安全

项目明确声明不做 openid whitelist，任何 C2C 发送者都能使用。源码确实没有在 Gateway 或 controller 中做 openid allowlist；所有发送者都能到达 `/run`、`/ps`、`/stop <pid>`、`/memory`、`/session`、`/model` 等命令。[README 声明](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/README.md#L9-L25)；[命令入口](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/app/controller.ts#L34-L139)；[进程终止命令](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/app/controller.ts#L306-L350)

非 Docker 默认使用 `-a never -s workspace-write`；Docker 镜像/Compose 则默认 `danger-full-access`，容器内 Codex bypass approval/sandbox。容器挂载限制了宿主暴露面，但 bot 仍能读写挂载的 workspace、data、Codex home 和 cron directory，且镜像没有切换到非 root `USER`。[runner sandbox args](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/codex/runner.ts#L167-L183)；[Docker ENV](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/Dockerfile#L129-L145)；[Compose mounts](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/docker-compose.yml#L9-L23)

### 6.5 持久化与投递

Gateway seq/session、thread、named sessions 和 queue 都写同一个 JSON 文件；写入是直接 `writeFileSync`，没有临时文件、fsync、rename、锁或 schema/version 检查。并发 patch 是 load-modify-write，进程崩溃或并发写都有覆盖/截断风险。[StateStore](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/state.ts#L22-L57)

没有 provider event ID ledger 或 inbound dedupe。Gateway 收到任何 seq 时先 patch `qqSeq`，随后才处理 dispatch；崩溃窗口与第一个仓库相似，但这里连业务 inbox 都没有。[seq 与 dispatch 顺序](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/qq/gateway.ts#L93-L140)

outbound 是同步逐 chunk HTTP POST；唯一的 fallback 是 Markdown 失败后改发 text。没有 outbox、attempt state、provider receipt 持久化、指数退避或重启补发。[send loop/fallback](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/qq/messages.ts#L19-L50)；[text send](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/src/qq/messages.ts#L109-L137)

### 6.6 部署与成熟度

Dockerfile 会在 build 时执行 `npm view @openai/codex version`，然后安装查询到的版本；没有 build arg、lockfile 或显式常量固定 Codex 版本，同一 commit 在不同时间重建可能得到不同 Codex。[Codex install](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/Dockerfile#L91-L112)

仓库只有 11 个 commits、无 tag、无测试目录、无 GitHub Actions，manifest 也没有 test/check 脚本；README 开头明确警告项目主要由 AI 生成并要求使用者自行审查。这些都是早期原型信号。[manifest](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/package.json#L1-L18)；[README warning](https://github.com/uniqueFranky/Codex-QQBot/blob/fb47a9f7c497fa2dbb743023934a431db42743be/README.md#L1-L7)

## 7. 横向结论

### 7.1 架构

- `qq-codex-bridge` 最接近可抽象的 channel-neutral bridge：adapter、orchestrator、ports、store 的边界已存在。
- `codex-qq-bot` 是功能丰富的本地 Agent Hub；QQ 社交、记忆、dashboard 和安装器与 Bridge 核心高度耦合，直接采用意味着接受更大的产品范围。
- `Codex-QQBot` 是一个单用户假设下的 CLI wrapper，核心代码短，但缺失项不是简单补几行即可解决，而是需要重做身份、会话、审批和可靠性边界。

### 7.2 QQ 平台路线

- `qq-codex-bridge` 与 `Codex-QQBot` 使用腾讯官方 Bot API/Gateway，但都是自写 protocol client；它们仍需与官方协议/SDK版本做 contract test。
- `codex-qq-bot` 使用 OneBot/NapCat，能获得更丰富的个人 QQ/群管理能力，但不能把它的账号、身份和合规假设直接搬到官方 QQ Bot adapter。

### 7.3 Codex 原生程度

- 协议控制面最完整的是 `codex-qq-bot`：正确 initialize/initialized、thread resume、turn start、steer、interrupt/replacement、dynamic tools。
- 进程模型更适合长期 bridge 的是 `qq-codex-bridge`：一个 daemon 管一个长驻 App Server；但当前握手、server request 和恢复能力仍需补齐。
- `Codex-QQBot` 依赖 `codex exec --json`，只获得 CLI 输出事件和 resume，无法承接完整 App Server server request 生命周期。

### 7.4 安全与隔离

- 三者都不是多 Profile、互不信任租户隔离实现。
- `codex-qq-bot` 的 channel 层身份/命令策略最完整，并隔离 Codex child env；但普通 Codex approval 不是 QQ 交互审批。
- `qq-codex-bridge` 缺 channel ACL 和 approval transport。
- `Codex-QQBot` 明确允许所有 C2C 用户、共享 thread/queue，并允许发起运行命令和停止进程；只有在 bot 可见范围被严格限制、且容器挂载极窄时风险才可能被外部边界部分缓解。

### 7.5 可靠性

- `qq-codex-bridge` 是唯一已有 SQLite inbound ledger 和 outbox 形状的仓库，但 outbox 还没有实现状态机。
- `codex-qq-bot` 有细粒度 delivery receipt 和原子 thread-map persistence，但 inbound dedupe、pending follow-up 和 send/retry 仍是进程内或非事务流程。
- `Codex-QQBot` 只有 Gateway resume 和普通 JSON state，没有 inbound/outbound 可靠性层。

## 8. 对独立 Codex Channel Bridge 的可复用价值与不可直接采用部分

可以研究的实现模式：

- 从 `qq-codex-bridge` 参考 channel port、session key、官方 QQ Gateway 和 App Server 长驻连接的模块边界；但不能把现有 `delivery_jobs` 当成已完成 outbox，也不能沿用统一 `-32601` 的 server request 策略。
- 从 `codex-qq-bot` 参考 stdio JSONL parser、initialize/initialized、native steer/replacement、bounded limiter、原子 JSON writer、sender-aware dynamic tools 和 delivery receipt；但不能引入其 OneBot/NapCat 作为官方 QQ adapter，也不能复制无许可证源码。
- 从 `Codex-QQBot` 参考最小官方 QQ token/Gateway/C2C send 流程和 Docker workspace 隔离示例；不能沿用全局 thread/queue、无 ACL、`codex exec` 或 build-time latest Codex。

三个仓库都不能直接提供的能力：

1. Profile / Channel Account / provider identity 的强绑定与跨 Profile 防串线；
2. 原 provider event ID 的 durable inbox 与 Codex input correlation；
3. terminal result + outbox 同事务提交；
4. send attempt、ambiguous outcome、provider receipt、bounded retry 和重启 reconciliation；
5. approval/requestUserInput 的原 request、原连接 generation、原 channel participant 三方绑定；
6. capability probe、版本矩阵、App Server circuit breaker、bounded drain；
7. body-free audit、support bundle、profile disable/purge 等运维控制面。

## 9. 验证范围与限制

本次完成：

- 克隆三个默认分支并固定 SHA；
- 阅读全部 manifest、QQ ingress/egress、Codex runner/client、state/store、concurrency、权限入口和部署文件；
- 对三个 checkout 全局搜索 `delivery_jobs`、`outbox`、`retry`、`requestApproval`、`requestUserInput`、`turn/steer`、`turn/interrupt`、`openid`、`dedupe` 等实现特征；
- 本地运行 `codex-qq-bot` 的 Node test suite，结果为 439/449 pass，10 个失败受当前 sandbox/路径/安装脚本环境影响；
- 核对许可证文件、CI workflow、tag 和 commit metadata。

本次没有完成：

- 没有使用真实 QQ 凭证做 provider acceptance；
- 没有启动真实 Codex App Server 验证协议版本兼容性；
- 没有在 Linux/Docker/Windows 目标机运行安装与生命周期测试；
- 没有测断电、send-then-crash、App Server restart、provider replay 等故障注入；
- 没有核验 GitHub 外部的作者授权，因此无 LICENSE 仓库仍按“不可默认复用”处理。

因此，本报告可以支持源码层架构比较和选型风险识别，不能替代真实 QQ、真实 Codex 版本和目标平台上的端到端验收。
