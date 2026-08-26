# 开发基线

## 当前实现阶段

当前 Runtime Slice 建立以下明确的 Package Boundary：

1. `@codex-channel-bridge/core` 定义共享的 Profile Health 词汇与 Channel-neutral Adapter Contract。
2. `@codex-channel-bridge/codex-app-server` 负责 Newline-delimited JSON Framing、Request Correlation、Generated-schema Capability Probe 和受监督的 App Server Child Edge。
3. `@codex-channel-bridge/profile-worker` 负责一个 Profile 专属子进程、Readiness、Thread 启动或复用、Turn 启动和终态结果收集。
4. `@codex-channel-bridge/config` 负责严格 YAML 解析、Environment Override、Secret Reference Resolution、完整静态验证和 Configuration Revision Hash。
5. `@codex-channel-bridge/profile-store` 负责 Profile 专属 WAL SQLite Schema、Provider-event Deduplication、Recent-message Read 和 FTS5 Lexical Search。其异步接口把同步 SQLite Work 发送到专用 Worker Thread。
6. `@codex-channel-bridge/supervisor` 负责前台 Deployment Process、已接受的 Desired Configuration、Multi-profile Transition 和有界 Worker Child-process Restart Policy。
7. `@codex-channel-bridge/control-plane` 负责版本化 Local JSONL Administration Contract、Platform Endpoint Edge、Authorization Hook 和两阶段 Configuration Plan/Apply Protocol。
8. `@codex-channel-bridge/cli` 暴露 Host-local Development Command。
9. `@codex-channel-bridge/qq-adapter` 固定腾讯官方 QQ Bot SDK，规范化 C2C 与群 Event，并映射 Text Delivery Outcome，但不拥有 Routing 或 Codex Behavior。

任何 Package 都不存储 Codex Thread 或 Turn History。Profile Worker 发送原生 App Server Request，并消费原生 Item 和 Turn Event。

## 工具链

- Node.js 22 或更高版本
- npm 10 或更高版本
- TypeScript 5.9
- 由管理员提供的 `codex` Executable

安装依赖并运行 Unit Suite：

```sh
npm install
npm test
```

## 平台验证优先级

按以下顺序实现并验收平台行为：

1. 在本地开发机器上验证原生 macOS。
2. 在 SSH 别名 `marvel-mini-pc` 指向的远程主机上验证原生 Linux。
3. 使用 `marvel-mini-pc` 的 Docker Engine 验证 Linux Docker。

每项平台专属的 Contract、Process Lifecycle、Filesystem Permission、Signal/Drain 和 Packaging Test 都必须在真实目标上运行。macOS 结果不能验证任何 Linux 目标，原生 Linux 结果也不能验证 Container Image。Windows 仍是首版目标，但要等前三个目标通过并指定真实 Windows 验证主机后再继续。

每次运行前检查目标当前的 Node.js、npm、相关场景下的 Docker，以及管理员提供的 Codex 版本。缺少前置依赖时，将其报告为环境缺口。Bridge 及其验证流程不得在任何主机上安装或升级 Codex。

### 验证快照：2026-08-26

| Target | Runtime | 结果 |
| --- | --- | --- |
| 原生 macOS | Node `22.23.1`、npm `10.9.8`、Codex `0.149.1` | 51 项 Unit Test、3 项 Control-plane Contract、Supervisor Process Contract、Codex Protocol Contract 和 npm Audit 通过 |
| 原生 Linux（`marvel-mini-pc`） | Ubuntu Kernel `6.8`、Node `22.22.1`、npm `10.9.4`、Codex `0.149.1` | 全新 `npm ci`、相同 Unit/Control/Supervisor/Codex Contract 与 npm Audit 通过 |
| Linux Docker（`marvel-mini-pc`） | `node:22-bookworm`、Node `22.23.2`、npm `10.9.8`、只读挂载 Codex `0.149.1`、全新空 Codex home | 全新 `npm ci`、相同 Unit/Control/Supervisor/Codex Contract 与 npm Audit 通过 |

Docker Run 没有挂载宿主 Codex home 或 Authentication State。Slim Node Image 因缺少 Python 和 C/C++ Toolchain，无法构建 `better-sqlite3`；完整 Bookworm Image 提供了预期 Build Stage 并通过测试。该结果验证 Runtime Behavior，不代表 Production Multi-stage Image 已完成；后者仍是未来 Packaging Work。

## 已测试 Codex 矩阵

| Codex CLI | 稳定 v2 Schema SHA-256 | 状态 |
| --- | --- | --- |
| `0.149.1` | `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9` | 已测试 |

Source of Truth Manifest 是 `protocol/codex/0.149.1/manifest.json`。Bridge 从实际配置的 Executable 重新生成 Schema。低于最低版本或缺少所需稳定 Method 时失败关闭。更新但兼容的 Schema 可以运行，但报告为 `unverified`。

运行真实、不会创建 Thread 的 Contract Test：

```sh
npm run test:contract
```

该测试执行 `initialize`、发送 `initialized` 并调用 `model/list`，不会创建 Codex Thread 或 Turn。

运行真实 Process-tree Contract Test：

```sh
npm run test:supervisor-contract
```

该测试启动一个健康 Profile 和一个刻意设为 Unavailable 的 Profile。它验证 Supervisor 保持 Live、健康 Worker 达到 `ready`、不可用 Sibling 失败关闭，并且两个 Worker Process 都会停止且不创建 Turn。

运行真实 Unix Control-plane Contract Test：

```sh
npm run test:control-contract
```

该测试验证 Owner-only Socket、Structured Request/Response Framing、逐请求 Authorization、拒绝行为以及禁止替换活动 Endpoint。它需要允许 Unix-domain Socket 的 Host Environment。

## 可选真实 QQ Contract

QQ Live Contract 连接已配置 Test Robot，等待一条 C2C 或 Group Event，并使用固定 Marker 进行被动回复。它绝不输出 Message Body、Provider Identity、Credential、Secret Reference Name 或 Provider Message ID。它会真实发送一条 QQ Reply，因此只有在接受该 Side Effect 时才运行：

```sh
BRIDGE_QQ_LIVE_SECRETS_FILE=/absolute/path/to/secrets.env \
npm run test:qq-live
```

显式选择的 Owner-only File 可以使用一组常见 QQ Credential Name。对于非标准 Dotenv Name，可在 Process Environment 中设置 `BRIDGE_QQ_APP_ID_REF` 和 `BRIDGE_QQ_APP_SECRET_REF` 进行选择，不需要把 Value 放进 Argument。已验证和仍待确认的 Provider Contract 见 `docs/zh/qq-adapter.md`。

## 可选端到端 Smoke Turn

Smoke Test 使用 Operator 提供的 Codex home，并消耗一个真实 Codex Turn。它会在所选 Workspace 中创建真实 Codex Thread。只有明确接受该 Side Effect 时才运行：

```sh
CODEX_HOME=/absolute/codex/home \
BRIDGE_SMOKE_WORKSPACE=/absolute/workspace \
npm run test:smoke
```

等价的 CLI 路径从 Stdin 读取 Codex Input，因此 Message Text 不会成为命令行参数：

```sh
printf 'Reply briefly.' | node packages/cli/dist/main.js codex turn \
  --profile local-dev \
  --workspace /absolute/workspace \
  --codex-home /absolute/codex/home \
  --state-directory /absolute/bridge/state
```

## 协议行为

- App Server Stdout 只承载协议。空白或非 JSON 输出均为 Protocol Fault，并拒绝所有 Pending Work。
- App Server Stderr 单独消费。首个阶段只保留有界且不含内容的 Byte 与 Chunk Count，从不保留原始 Stderr Text。
- 不启用 Experimental API。
- 未处理的 Server-originated Approval Request 或 User-input Request 会收到 JSON-RPC Method-not-found Response。在 Channel Approval Transport 实现前，这会失败关闭。
- Model Selection、Reasoning、Reviewer Policy、Sandboxing、Compaction 和 Thread Persistence 仍由 Codex 所有。

## 当前开发限制

- Runtime `config apply` 只能通过 Host-local Control Plane 和完整 Revision Confirmation 使用。进程不监视 `config.yaml`，也不通过 Signal Reload。
- 崩溃的 Worker 会在 60 秒窗口内以 1、2、5 秒的有界延迟在 Profile 本地重启。再次崩溃会打开 Profile-local Stop Condition `worker_restart_exhausted`；Supervisor 与 Sibling Profile 保持 Live。Administrator Reset 和基于 Cooldown 的恢复尚未实现。
- 因为 Node.js 不暴露 Peer Credential，Unix 访问目前依赖验证过的 Service-user Ownership 和 Mode。Windows Named-pipe Path 已存在，但严格 ACL 的设置和验证仍是未经测试的平台工作。尚未实现 Web Administration Console。
- 当前 Profile Drain 会停止 App Server，因为 Channel Admission、Active-turn Tracking、Approval Transport、Queue 和 Durable Outbox 尚不存在。它们最终的 Drain Condition 仍由 ADR 定义。
- Profile Store 当前只实现持久化、Event-loop 外 Storage Worker 与 FTS5 词法检索基础。完整本地 Hybrid Retrieval、Archive MCP Server、Archive Purge、Media Persistence 和 Durable Outbox 尚未实现。
- QQ Adapter 已连接并归档规范化 C2C/Group Event，但 Access Policy、Conversation-to-Thread Routing、被动回复 Sequence Persistence、Durable Outbox Retry 和 Codex Result Delivery 尚未实现。
