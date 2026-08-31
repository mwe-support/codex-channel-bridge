# Message Archive 持久化基线

## 范围

`@codex-channel-bridge/profile-store` 是首个 Bridge-owned Persistence Slice。它存储规范化的 QQ 和 WhatsApp Message Event，但不复制 Codex Thread 或 Turn History。当前 Package 提供 Provider-event Deduplication、有界 Recent-message Read、Literal-token FTS5 Search，以及 [`delivery.md`](delivery.md) 所述的 Atomic Logical Result 与 Durable Outbox Contract。

这不是完整的 Local Hybrid Retrieval 实现。Substring、Fuzzy、Structured、Recency Fusion、Archive MCP、Media 和 Purge 行为留到后续阶段。

## Profile 所有权

每个 Profile 配置一个专属 `stateDirectory`。该目录不能与任何 Profile 拥有的 Workspace 或 Codex home 重叠。在 macOS 和 Linux 上，它必须是真实目录、由 Service User 所有且 Mode 为 `0700`。

Profile Worker 在启动时打开 `stateDirectory/bridge.sqlite`，并在 Drain 时关闭。新文件设置为 Mode `0600`。已有 Symlink、非 Regular File、错误 Owner 或更宽的 Mode 都会在 Codex 启动前让 Profile 以 `profile_store_unavailable` 原因失败关闭。

数据库记录所属 Profile ID。使用另一个 Profile 打开时以 `profile_mismatch` 失败；数据绝不被静默接管或移动。

## SQLite Contract

- `better-sqlite3` 固定为 `13.0.3`，要求 Node.js 22 或更高版本。
- 必须启用 WAL Journal Mode、Foreign Key、`synchronous=FULL` 和 FTS5。
- 新的空数据库初始化为 Bridge Schema Version 8。
- 未知或更旧的 Schema 返回 `migration_required`；正常启动不执行 Migration，受影响的 Profile 不启动 Codex。显式 Host-local Migration Workflow 当前只支持已知的 Version 3、4、5、6 或 7→8；参见 [`migrations.md`](migrations.md)。
- Deduplication Identity 是 `(Channel Account Epoch ID, Provider Event ID)`。
- Recent Read 最多返回 500 条记录，并在所选近期窗口内保持时间正序。
- FTS5 Search 把输入视为以空白分隔并用 `AND` 连接的 Literal Token；不暴露 Raw FTS Query Syntax，也不是 Semantic Search。

规范化的 External Identifier 必须非空，每项最大 8 KiB。Text Body 可以为 null，UTF-8 最大 1 MiB。这些限制保护本地 Persistence Interface；Provider Adapter 可以使用更严格的限制。

## Event-loop 规则

`better-sqlite3` 是同步引擎。Channel Adapter 不得从自身 Event Loop 调用 Store。`ProfileStore` 现在只暴露异步 Operation，并在每个 Profile 专属的 Node.js Worker Thread 中运行同步 SQLite 实现。Profile Worker 在 Codex 之前打开该 Storage Worker。其唯一的 Inbound Pipeline 将 Adapter-owned Provider Fact 与 Worker-owned Profile、Channel Account 和 Account Epoch Context 合并，派生 Conversation Key，提交规范化 Event，并且只把新插入的 Event 交给后续 Routing Work。Storage Failure 会让 Profile 进入 Unavailable 并停止其 Channel Adapter；Bridge 绝不从未提交的 Event 启动 Codex Work。无效或 Provider 不匹配的 Adapter Event 则只隔离该 Adapter，Codex 与 Sibling Adapter 保持可用。

## 验证

Unit Suite 只创建临时 Profile Directory，除了 WAL、Owner-only File Mode、持久 Reopen、Deduplication、Recent Ordering、FTS5、Profile Mismatch、显式拒绝 Migration 和拒绝 Symlink外，还会验证异步 Worker Seam：

```sh
npm test
```

平台验收必须分别在本地 macOS、`marvel-mini-pc` 的原生 Linux，以及同一远程主机上的 Linux Docker 中运行该 Suite。

当没有匹配的 Prebuilt Binary 时，`better-sqlite3` 可能从源码编译。因此 Linux Docker 的 Build Stage 需要 Python 3、`make` 和 C++ Compiler。这些工具应只存在于后续的 Multi-stage Build Image 中，不能扩大最终 Runtime Image。
