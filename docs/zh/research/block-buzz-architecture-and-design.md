# Block Buzz：架构与设计理念

- 调研日期：2026-08-27（Asia/Shanghai）
- 上游快照：[`b622003f74aa5bf9b659786452813299a25e4897`](https://github.com/block/buzz/commit/b622003f74aa5bf9b659786452813299a25e4897)
- 来源范围：仅使用一手资料——Block 官方仓库的 README、愿景/架构文档、manifest、实现源码、测试、CI 与发布元数据。
- 证据标记：**源码事实**表示已直接从代码或配置核实；**官方意图**表示 Buzz 自己声明的方向；**本文推断**表示本报告基于证据作出的解释。

## 结论先行

Buzz 的本质并不是“带 AI 的聊天客户端”，而是一个可自托管的协作工作区，统一底座是 Nostr relay。人的消息、agent 工作、reaction、workflow 步骤、Git 活动和审批，都以同一身份模型下的签名事件表示，并进入同一套可搜索历史。Relay 是权威事实源；客户端之间不做 P2P gossip 或状态复制。Buzz 自己定位为事件存储、搜索、订阅与投递的“管道”，智能来自参与其中的人和 agent。来源：[README](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L27-L42)、[架构总览](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L3-L18)、[愿景](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L1-L11)。

实现上，它是以一个 Axum relay 进程为中心的模块化 Rust monorepo：Postgres 是持久事件与搜索存储，Redis 负责跨节点 pub/sub 和短暂协调状态，S3/MinIO 保存媒体和 Git 对象。桌面端与 Web 端使用 TypeScript/React，桌面壳是 Tauri 2，移动端使用 Flutter。Agent 集成遵循协议优先：Buzz 事件进入 ACP harness，agent 通过 stdio 上的 ACP 工作，工具通过 stdio 上的 MCP 工作。来源：[workspace manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/Cargo.toml#L1-L41)、[README crate map](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L194-L240)、[桌面端 manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/desktop/package.json#L1-L24)、[移动端 manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/mobile/pubspec.yaml#L1-L26)。

它最强的设计思想，是让人、agent、workflow 和 repository 在“事件与身份”边界上成为同类参与者，而不是用大量定制胶水连接若干独立产品。代价也正来自这项选择：relay 会成为很大的集成点，Nostr `kind` 的语义与权限策略必须一直保持纪律，而且当前部分源码已经走在架构/状态文档前面。

## 1. 项目定位与边界

### Buzz 负责什么

**源码事实：**Buzz 负责工作区底座，包括签名事件接入、身份认证、channel membership、持久化、搜索、实时订阅、workflow 触发、媒体、Git 托管和审计。一个 community 由请求 host 选择；在 handler 能读取租户数据之前，连接就绑定到服务端解析出的 community，客户端输入不能覆盖它。来源：[架构总览](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L3-L18)、[连接状态](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L50-L80)。

**官方意图：**“relay 就是 workspace”：一个 community 应在同一个 URL、身份体系和搜索索引下容纳对话、agent、自动化、artifact、文档与 repository。来源：[愿景](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L1-L11)。

### Buzz 明确不是什么

- 它不是区块链；使用签名事件并不意味着引入加密货币或共识系统。
- 它不是替代人的 AI 方案；官方把 agent 定义为房间里的协作者。
- 它不是已完成的产品；README 明确区分已交付、开发中与仍属设想的能力。来源：[README 状态边界](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L98-L109)、[“What it is not”](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L275-L287)。

**本文推断：**Buzz 更接近“自托管协作操作系统”或集成式 forge/workspace，而不是“Slack 加一个 bot”。它押注平台级统一事件底座能够取代若干彼此独立、各自建索引的系统。

## 2. 技术栈与模块分层

```text
桌面 / Web / 移动端       Agent runtime       CLI 与自动化
         | WebSocket/HTTP    | ACP + MCP        | WebSocket/HTTP
         +-------------------+------------------+
                             v
                  buzz-relay（Axum、Tokio）
       auth | ingest | subscription | workflow | git | media | audit
             |              |              |
             v              v              v
       Postgres 17        Redis 7        S3 / MinIO
      事件 + FTS       pub/sub + TTL       媒体 + Git 对象
```

### 第 1 层：协议内核

`buzz-core` 包含事件类型、签名/ID 校验、filter matching、kind 定义、租户原语与安全辅助函数。它的 manifest 刻意不依赖 Tokio、SQLx、Redis 或 Axum，从而维持一个 zero-I/O 的领域层。来源：[buzz-core manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-core/Cargo.toml#L1-L27)。

通用 wire/domain 对象是 Nostr event：canonical ID、secp256k1 公钥、整数 `kind`、tags、content 与 Schnorr 签名。`kind` 是分派与扩展的开关；标准 Nostr kinds 与 Buzz 自定义范围并存。来源：[协议与 kind 范围](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L101-L163)、[`kind.rs`](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-core/src/kind.rs#L1-L41)。

### 第 2 层：职责聚焦的 service crates

- `buzz-db`：Postgres 持久化与事务性领域状态。
- `buzz-auth`：NIP-42 WebSocket 认证、NIP-98 HTTP 认证、scope、replay protection 与限流接口。
- `buzz-pubsub`：Redis fan-out、presence、typing、cache invalidation，以及 Redis-backed admission limiter。
- `buzz-search`：基于事件表 generated Postgres FTS column 的候选搜索；最终权限仍由 relay 约束。
- `buzz-audit`：按 community 分链的 hash-chain audit log。
- `buzz-workflow`：YAML 定义、trigger、action 与执行状态。
- `buzz-media`：Blossom/S3 媒体处理。

声明的依赖规则是：这些服务不直接彼此协调；`buzz-relay` 负责导入并编排它们。来源：[crate hierarchy](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L75-L99)、[workspace members](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/Cargo.toml#L1-L34)。

### 第 3 层：relay composition root

`buzz-relay` 是唯一的组合点。其 `AppState` 持有共享且大多由 `Arc` 包装的服务和有界并发/状态原语，包括 DB 与 Redis pool、auth、search、subscription、connection、workflow engine、media/git store、semaphore、有界 audit channel、TTL cache、replay guard 和 rate limiter。来源：[当前 AppState](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L630-L760)。

这更像 modular monolith/relay core，而不是一组独立部署的服务。Redis 允许多个无状态 relay 实例跨节点传播事件，但领域编排仍在 `buzz-relay` 内完成。

### 第 4 层：客户端与 agent surface

- 桌面端：React 19 + TypeScript + Vite，运行在 Tauri 2 内；Playwright 验证渲染流程。
- Web 端：独立 React/Vite package，承载浏览器与 repository surface。
- 移动端：Flutter/Dart。
- Agent：`buzz-acp` 把 relay 事件桥接给 ACP child；`buzz-agent` 是 ACP agent；`buzz-dev-mcp` 提供工具；`buzz-cli` 提供面向 JSON 自动化的原语。SDK 现在还定义了 broker contract，让**不持有密钥**的 agent 请求持钥 host 代为行动。这个提交只提供 contract、严格 wire type 和 client trait，并没有 broker host、具体 transport、relay integration、signing 或 Desktop integration。来源：[agent 架构](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION_AGENT.md#L7-L42)、[broker 模块边界](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L1-L19)、[显式 non-goals](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L46-L59)。

## 3. 运行时与数据流

### 3.1 连接与租户绑定

1. 在接收 frame 前，请求 host 被解析为 `TenantContext`。
2. Relay 获取 connection semaphore permit；容量耗尽时立即拒绝。
3. Relay 发出 NIP-42 challenge，并要求客户端在有界时间内完成认证。
4. receive、send 与 heartbeat loop 在同一个 cancellation token 下并发运行。
5. 每连接 auth state 使用 `RwLock`，subscription 变更使用 `Mutex`，data/control frame 走独立的 bounded channel。
6. 任意退出路径都会清理 subscription 与 connection registry 状态。来源：[连接生命周期设计](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L165-L219)、[当前连接实现](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L25-L116)、[连接 admission](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L140-L233)。

### 3.2 持久事件写入

WebSocket `EVENT` 与 HTTP `POST /events` 刻意进入同一个 transport-neutral `ingest_event` pipeline。这个共享入口统一执行 community lifecycle fence、auth/scope、signer、签名与 canonical ID、kind-specific validation、membership/role policy 和 persistence。来源：[ingest 模块契约](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/ingest.rs#L1-L4)、[共享 ingest 入口](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/ingest.rs#L2088-L2160)。

Postgres insert 使用 `ON CONFLICT DO NOTHING`，因此 event ID 提供幂等去重，DB API 还会返回该行是否真正插入。AUTH 与 ephemeral event 会被 durable store 拒绝。来源：[event store](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-db/src/event.rs#L1-L8)、[insert path](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-db/src/event.rs#L300-L350)。

持久写入后，Buzz 先等待 audit record 进入 bounded channel，再调度 post-commit Redis publication、本地 fan-out 与 workflow trigger。当前实现明确把 NIP-01 `OK` 定义为“已持久接受”，而不是“所有下游副作用均已完成”。来源：[post-commit dispatcher](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/event.rs#L340-L391)、[fan-out 与 workflow path](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/event.rs#L396-L548)。

### 3.3 Ephemeral event 路径

Presence、typing 一类 event 会被验证，并通过 Redis/进程内协调投递，但刻意绕过持久事件存储、搜索与审计。这将“当前存活信号”与“历史记录”分开。来源：[ephemeral contract](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-db/src/event.rs#L1-L8)、[架构路径](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L246-L268)。

### 3.4 Subscription 与读取路径

`SubscriptionRegistry` 使用并发 `DashMap` index 保存 active filters，索引键包括 community、channel、kind，部分路径还包括 recipient。常见 fan-out 因此不必扫描全部 subscription；注册范围以服务端解析的 community 为准。来源：[subscription indexes](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/subscription.rs#L70-L119)。

历史读取查询 Postgres；live event 既在本进程 fan-out，也通过 Redis 传播到其他 relay 实例。发送 chokepoint 会重新验证 community 与 private-channel access，所以 stale subscription 或 cache 本身不足以授权投递。Redis 本地回声用 `(community_id, event_id)` 为 key 的 TTL cache 去重。来源：[fan-out access gate](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/event.rs#L91-L237)、[tenant-scoped echo cache](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L670-L710)。

### 3.5 Agent 路径

```text
Buzz event / @mention
  -> buzz-acp 通过 relay WS 订阅
  -> 每 channel queue，同一 channel 最多一个 in-flight prompt
  -> 通过 stdio ACP JSON-RPC 发送给 agent
  -> agent 通过 stdio 调用每 session 独立的 MCP server
  -> 工具执行工作
  -> agent 通过 CLI/MCP 发布签名 Buzz event
```

Agent protocol、tool protocol 与 relay protocol 被刻意分开。每个 session 拥有独立 MCP server process/state，agent 不通过内部 import 绑定某个工具实现。来源：[agent 原则与拓扑](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION_AGENT.md#L21-L56)、[ACP relay 行为](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L644-L676)。

新的 agent-to-broker seam 为不持有 Nostr secret key 的 agent 增加了另一条 action path：agent 构造 typed `BrokerRequest`，冻结序列化后的 bytes，再携带 opaque session credential 发送到单一 `/v1/action` endpoint；host 完成 authenticate、authorize、validate、execute，并在需要时签名/发布，最后返回可关联的 envelope。封闭的 v1 action vocabulary 有九项：读取 channel；post、reply、react；设置 profile；推导 memory storage address；以及创建、更新、删除 agent。它刻意暴露业务 operation，而不是原始 `sign(bytes)`，从而支持按 operation 制定 policy。来源：[contract topology 与 authority](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L9-L39)、[action set](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/actions/mod.rs#L132-L180)、[HTTP binding](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/client.rs#L1-L35)。

它的可靠性 contract 很明确：retry 必须在同一 request ID 下重发完全相同的 frozen bytes；cursor 是 host 所有的 opaque token；读取成功返回签名 Nostr event，因此 keyless agent 可在本地验证；caller 只能取得已经与原 request 做 correlation 和 validation 的 response；unknown field 和显式 `null` 都被拒绝。Host refusal 是有效 result；拿不到可用 envelope 才属于 transport-level **indeterminate**，此时不能推断副作用是否发生，安全选择只有 identical-byte retry 或读取状态做 reconciliation。来源：[request 与 retry contract](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L97-L125)、[validated client door](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/client.rs#L96-L123)、[transport uncertainty](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/client.rs#L48-L81)。

## 4. 关键抽象与扩展点

| 抽象 | 作用 | 扩展方式 | 主要代价 |
|---|---|---|---|
| 签名 Nostr event | 通用 action/record envelope | 增加 `kind`、校验、typed builder、读写策略与客户端 renderer | “新 kind”保持 wire compatibility，但不等于零实现成本 |
| `TenantContext` / `CommunityId` | host-derived 租户标签 | 贯穿每个读、写、cache、pub/sub、audit、git 和 media 路径 | 缺失标签就是隔离缺陷，因此 plumbing 无处不在 |
| `buzz-core` | 纯协议/领域内核 | 增加类型和验证逻辑，但不引入 I/O | 易测试，但编排复杂度被推到外层 |
| Service crate | 聚焦的 storage/auth/search/workflow 边界 | 增加 crate 或窄 service API；只在 relay 协调 | 避免 service 间纠缠，但 relay composition 会变大 |
| `AppState` | 运行时 composition root | 一次注册 service、cache、limiter、queue 或 semaphore | 中央可见性强，但状态对象很大 |
| `SubscriptionRegistry` | Indexed live-query state | 为新常见访问模式增加 bounded、tenant-labelled index | 索引越多，fan-out 越快，但变更/清理越复杂 |
| YAML workflow | 用户级自动化 | 增加 trigger/action enum variant 与执行支持 | Schema 可能领先实现；当前 approval/action 就体现了该风险 |
| ACP / MCP / provider binary | Agent 与工具边界 | 替换 agent、MCP server、LLM provider 或 remote backend executable | subprocess lifecycle 与 protocol conformance 成为正确性边界 |
| Broker `Action` / `BrokerClient` | Keyless agent 的 least-authority host action | 增加经过评审的 typed operation；在 object-safe trait 后替换 in-process/HTTP client | 封闭 vocabulary 让 policy 可审计，但每个新 operation 都是有意的 contract/versioning 变更；host 实现尚未出现 |

**本文推断：**Buzz 真正的扩展 API 不是单一 plugin SDK，而是 protocol kind、crate boundary、relay composition、workflow enum、CLI/MCP tool 与 executable protocol 的组合。这很灵活，但要求多个 surface 之间有协同的 contract tests。

## 5. 并发、状态与错误处理

### 有界并发与背压

- Connection、handler、git、media、workflow 与 agent session 的并发都由 semaphore 或配置上限约束。
- WebSocket data/control channel 分离；普通 data buffer 满时，control frame 仍能优先处理。
- 持续 slow-client backpressure 会取消连接，而不是允许 queue 无界增长。
- Heartbeat 在连续 missed pong 后关闭 stalled connection。
- Workflow 容量不足时 fail fast，而不是进入无界内部队列。来源：[连接状态与发送策略](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L50-L116)、[handler admission](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L600-L711)、[workflow bounds](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L509-L558)。

### 状态放在哪里

- Postgres 是 event 与 relational domain state 的持久事实源；搜索是 stored event row 上的 generated `tsvector`，不是独立 external index。
- Redis 保存跨节点投递与 expiring coordination，例如 presence、typing、replay seen-set 和 admission counter。
- S3/MinIO 保存 content-addressed media 与 Git object。
- 进程内存保存 connection、subscription index、bounded queue、room state 与 TTL cache；它们是可丢弃 projection，而不是持久事件事实源。来源：[当前 state fields](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L630-L760)、[Postgres FTS](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L464-L491)。

### 错误模型

Transport-neutral ingest layer 区分 client input rejection、authentication/authorization failure 和 internal failure；WebSocket 与 HTTP adapter 再映射到各自响应。Community lifecycle/DB 状态不确定时 fail closed。Metrics 使用 bounded reason label，防止 cardinality explosion。来源：[ingest error taxonomy](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/ingest.rs#L350-L405)。

Durability 语义有意不对称：event 落库后，即使后续 Redis fan-out 或 workflow trigger 失败，也可被确认；但 bounded audit queue 已满时，会在确认前向写入路径施加 backpressure。**本文推断：**这优先保证 durable acceptance 与系统可用性，而不追求 Postgres、Redis、subscriber、audit storage 和 workflow 的跨系统事务原子性。因此 operator 需要用可观测性与 reconciliation 处理 post-commit failure；Buzz 并没有在这些系统之间实现 distributed transaction。

## 6. 测试、构建与发布

### 测试策略

**源码事实：**`just test-unit` 执行不依赖基础设施的测试；`just test` 还会启动 Postgres/Redis integration dependencies。Relay E2E 需要 live relay，并在 CI 中显式选择。Desktop 包含 TypeScript/unit checks、Tauri Rust tests 与分片 Playwright smoke/integration suites；mobile 执行 format、analyze、test 与 Android debug build。Security/dependency policy 使用 `cargo-deny`，Linux server binary 为 x86_64 与 aarch64 musl 做 cross-compile。来源：[测试指南](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/TESTING.md#L3-L18)、[CI unit 与 desktop lanes](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/.github/workflows/ci.yml#L96-L238)、[relay E2E](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/.github/workflows/ci.yml#L777-L818)、[mobile/security/cross-compile](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/.github/workflows/ci.yml#L900-L975)。

CI 先检测 changed paths，跳过无关的高成本 lane；PR 新提交会取消已过时的运行。GitHub Actions 都 pin 到具体 commit SHA。来源：[CI entry](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/.github/workflows/ci.yml#L1-L68)。

### 构建与打包

Hermit 固定开发工具链，`just` 是任务入口，Cargo 构建 Rust workspace，pnpm 管理 desktop/web/admin package。本地 stack 使用 Docker Compose 的 Postgres、Redis 与 MinIO。生产提供 relay container，desktop package 覆盖 macOS、Linux 与 Windows。来源：[quick start](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L155-L182)、[workspace package setup](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/package.json#L1-L13)。

### 发布模型

Desktop、relay 与 mobile 是三个独立 release lane，版本也独立。Desktop 和 relay 走 reviewed release PR 与 immutable tag；mobile 从远端 `main` 的精确 commit 创建 immutable release-candidate tag。Desktop 还把 versioned release 与后续人工 auto-update promotion 分开，以限制 blast radius。来源：[release lanes](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/RELEASING.md#L1-L45)、[desktop/relay/mobile mechanics](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/RELEASING.md#L46-L128)、[publication 与 promotion](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/RELEASING.md#L199-L227)。

## 7. 核心设计理念及权衡

### 7.1 一个身份模型、一条事件日志

**官方意图：**人、agent、workflow 与 repository 共用签名事件结构及搜索/审计底座。Agent 是拥有 keypair 与 channel membership 的成员，不是特权全局 bot integration。来源：[README](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L78-L85)、[身份模型](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L85-L96)。

**权衡：**跨领域关联和审计更简单，但每项功能都必须被翻译成耐久的事件语义。统一逻辑底座并不表示 Git blob、audio frame、media、relational membership 与 ephemeral presence 在物理上完全一样；Buzz 仍需要专用 store 与 projection。

### 7.2 Relay 权威，而非 federated gossip

**源码事实：**客户端连接一个 authoritative relay；核心事件模型不包含 P2P event exchange、gossip 或 replication。来源：[架构总览](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L3-L18)。

**权衡：**policy、search、audit 和运维比开放 federation 更容易推理，但可用性与信任集中到 operator 的 relay deployment。

### 7.3 Community 是由 URL 派生的安全标签

**源码事实：**AUTH/读/写处理前就由 host 决定 community；tenant label 进入 DB key、Redis key、subscription index、cache、audit chain 和 delivery gate。来源：[连接绑定](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L50-L80)、[subscription scope](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/subscription.rs#L70-L119)。

**权衡：**租户边界显式、可测试，但属于 cross-cutting concern。每个新 durable row、cache、error、subscription 或 external side effect 都必须携带或重新建立标签。

### 7.4 纯 core、聚焦 service、中央编排

**源码事实：**`buzz-core` 无 I/O，service crate 各自聚焦，relay 负责协调。这无需把每个 subsystem 都部署为 network service，也能获得局部可推理性和可测试性。来源：[core manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-core/Cargo.toml#L1-L27)、[dependency rule](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L75-L99)。

**权衡：**减少 distributed-service boundary、让事务更容易，但 relay binary 责任很广，composition root 也很大。

### 7.5 用标准组合，用进程隔离

**官方意图且得到源码结构支持：**ACP 连接 client 与 agent，MCP 连接 agent 与工具，Nostr 连接参与者与 workspace。项目偏好 protocol boundary 与独立 subprocess lifecycle，而不是 runtime internal coupling。Broker contract 把这个原则推进到 authority boundary：keyless agent 请求一个具名业务 operation，而 requester identity、scope、secret-key custody、signing 与 authorization 留在经过认证的 host session 中；request body 无法自行声称 requester 或 owner。来源：[agent 设计原则](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION_AGENT.md#L21-L56)、[broker authority rules](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L21-L44)。

**权衡：**agent 与工具更可替换，也可以在不给 agent signing key 的前提下按 operation 制定 policy。代价是协议面扩大：stdio/HTTP framing、cancellation、process-tree cleanup、timeout、idempotency、response correlation 以及 protocol/action-version conformance 都成为一等可靠性工作。Raw-signing primitive 更小、更易扩展，却会把 policy 压缩成全有或全无的 authority；Buzz 明确选择更可评审的封闭 operation set。

### 7.6 有界失败优于不可见过载

源码反复使用 bounded buffer、semaphore、timeout、TTL cache、fail-fast capacity check、slow-client disconnect 和 bounded output/history。**本文推断：**系统一致地偏好明确降级或拒绝，而不是让 memory/process 无界增长。这使运维行为更可预测，但在高负载时会表现为用户可见的 drop/rejection。

## 8. 已实现事实、愿景与文档漂移

仓库明确标记部分能力已交付、开发中或计划中。Workflow approval suspension/resume 尚未完整接通，部分 workflow action 仍是 stub，mobile 正在开发，remote-agent deployment 也没有被描述为完成状态。新的 broker code 只把这个方向推进到 interface layer：模块文档明确说明尚无 host、transport implementation、signing、relay change 或 Desktop integration。来源：[README 状态](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L98-L109)、[VISION 状态](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L216-L236)、[broker 状态边界](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L1-L19)。

下面两个具体例子说明：在这个快速演进的快照中，应以源码优先于总览文字。

1. `ARCHITECTURE.md` 仍描述 bounded `search_index_tx` worker，并把它列入 `AppState`；当前 event 源码明确说明该 worker 已随 Postgres generated `tsvector` 方案移除，当前 `AppState` 也没有 `search_index_tx`。来源：[已过时的架构 pipeline](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L221-L245)、[当前 event 源码](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/event.rs#L490-L507)、[当前 state](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L630-L760)。
2. Limitations table 仍称只有测试 limiter，而当前源码已经构造 Redis-backed admission limiter，并对 WebSocket/HTTP 工作执行检查。来源：[已过时的 limitation](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L816-L824)、[当前 limiter state](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L720-L744)、[当前 admission checks](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L622-L711)。

**本文推断：**架构方向是连贯的，但精确运行时结论必须固定到某个 commit，并同时核对源码、测试与部署配置，不能只依赖一份 overview 文档。

## 9. 适用与不适用场景

### 适合

- 团队希望自托管一个同时容纳人类讨论、agent、自动化、project memory 与 Git 活动的 workspace。
- 相比全局特权 bot，更看重可审计性与 identity-scoped agent。
- 团队接受 relay-authoritative model，并能运维 Postgres、Redis 与 object storage。
- 开发者希望通过 ACP/MCP 获得协议级 agent/tool 互换能力。
- 产品需要在 chat、workflow 与 development artifact 之间共用一套 event/search substrate。

### 不适合，或需谨慎

- 只需要一个轻量 chat bot 或单 agent UI：Buzz 的 relay、数据服务、客户端与 forge surface 明显过宽。
- 需要完全去中心化、P2P 或 federation-first 社交网络：当前架构刻意采用单一 authoritative relay/community boundary。
- 要求服务器无法读取内容的严格端到端加密协作：当前愿景把 at-rest protection 委托给存储层，NIP-44 E2EE 仍属未来考虑。来源：[加密定位](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L98-L102)。
- 当下就要求完整 workflow approval resume、成熟 mobile parity 或成熟 remote-agent deployment 的团队。
- 无法运维所需 stateful dependencies，或无法接受 post-commit side effect 并非一个原子事务的环境。
- 仅根据 vision prose 作合规决策：部分仓库 overview 文字目前落后于实现。

## 总结

理解 Buzz 架构最准确的一句话是：**以 relay 为中心、以签名事件为统一事实层、让 agent 成为一等参与者的协作平台。** Nostr 提供共同 envelope 与身份；Rust crate boundary 分开 protocol、persistence、auth、pub/sub、search、audit、workflow、media 与 agent concerns；relay 把它们组合成一个 authoritative workspace；Postgres/Redis/object storage 分别承载持久、短暂协调与 blob state；ACP/MCP 让 agent/tool runtime 保持可替换。

它优雅的地方，是统一边界：人、agent、workflow 和 repository action 可以共享身份、历史、搜索与审计语义。困难之处，是在维持这种统一性的同时，避免 relay 变成无边界 god object，并确保 tenant label、kind policy 与 post-commit failure semantics 不漂移。当前源码显示团队正积极加固这些边界，也显示代码演进速度已经超过部分架构文字。
