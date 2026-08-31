# Message Archive 持久化基线

## 范围

`@codex-channel-bridge/profile-store` 是 Bridge-owned Persistence Slice。它存储规范化的 QQ、WhatsApp Message Event 和 Channel-owned Attachment Fact，但不复制 Codex Thread 或 Turn History。当前 Package 提供 Provider-event Deduplication、有界读取、本地无 Embedding 的 Hybrid Retrieval、只读 Profile-local Archive MCP、有界 Media Mirroring、显式 Archive Purge，以及 [`delivery.md`](delivery.md) 所述的 Atomic Logical Result 与 Durable Outbox Contract。

## Profile 所有权

每个 Profile 配置一个专属 `stateDirectory`。该目录不能与任何 Profile 拥有的 Workspace 或 Codex home 重叠。在 macOS 和 Linux 上，它必须是真实目录、由 Service User 所有且 Mode 为 `0700`。

Profile Worker 在启动时打开 `stateDirectory/bridge.sqlite`，并在 Drain 时关闭。新文件设置为 Mode `0600`。已有 Symlink、非 Regular File、错误 Owner 或更宽的 Mode 都会在 Codex 启动前让 Profile 以 `profile_store_unavailable` 原因失败关闭。

数据库记录所属 Profile ID。使用另一个 Profile 打开时以 `profile_mismatch` 失败；数据绝不被静默接管或移动。

## SQLite Contract

- `better-sqlite3` 固定为 `13.0.3`，要求 Node.js 22 或更高版本。
- 必须启用 WAL Journal Mode、Foreign Key、`synchronous=FULL` 和 FTS5。
- 新的空数据库初始化为 Bridge Schema Version 9。
- 未知或更旧的 Schema 返回 `migration_required`；正常启动不执行 Migration，受影响的 Profile 不启动 Codex。显式 Host-local Migration Workflow 当前只支持已知的 Version 3、4、5、6、7 或 8→9；参见 [`migrations.md`](migrations.md)。
- Deduplication Identity 是 `(Channel Account Epoch ID, Provider Event ID)`。
- Recent Read 最多返回 500 条记录，并在所选近期窗口内保持时间正序。
- Hybrid Retrieval 融合 Exact、BM25/FTS5 Lexical、Substring、Trigram-fuzzy、Structured-filter 和 Recency Rank。它完全本地且确定性运行，不使用 Embedding、Vector Extension 或外部 Provider。

## Archive MCP

`bridge archive mcp --profile ID --state-directory PATH` 为一个 Profile 启动只读 stdio MCP Server，暴露有界的 `archive_search` 和 `archive_recent` Tool。Server 以 Read-only 方式打开现有 WAL Database，不修改 Codex Configuration，并从 Tool Result 中去除 Raw Provider Event 和 Participant Identifier。管理员可在 Profile 的 Codex-owned MCP Configuration 中注册该进程；Bridge 不会自动修改该配置。

## Attachment 与 Media

Message 与 Attachment Metadata 在任何 Byte Side Effect 之前进入同一个 SQLite Transaction。QQ 默认只保留 Provider Metadata 与 Link。WhatsApp 使用固定版本 Baileys 解密后的 Media Stream，并写入 `media/sha256/<prefix>/<digest>`。Profile-local `media` 配置通过 `perAttachmentLimitBytes` 与 `profileQuotaBytes` 设置限制；默认值为单 Attachment 64 MiB、单 Profile 已镜像 Byte 10 GiB。Profile 内部串行进行 Quota Decision，因此并发 Stream 不能超额占用配置容量。Limit、Quota 或 Stream Failure 只会把该 Attachment 标记为 `unavailable`；Metadata 继续保留，Bridge 不会把缺失 Byte 声称为 Durable Storage。新 Profile-worker Generation 会在 Adapter 启动前把继承的 `pending` Byte Operation 标记为 `unavailable` 并使用 `media_source_lost`；进程绑定的 Provider Stream 在 Restart 后绝不被假定可以 Replay。Attachment 永不自动执行。

## 显式 Purge

`bridge archive purge` 只支持一个 Profile 的整个 Archive，或一个精确 Conversation 在指定时间之前的记录。Plan 会报告 Message Count、去重后的 Referenced Media Byte、Live-reference Count 和 Selection Digest。Apply 同时要求完整 Profile ID 与预期 Count，只在 Profile 已 Disabled/Stopped 时运行，以 Transaction 删除 Base/FTS Row，仅回收无剩余引用的 Content-addressed Media，保留 Thread Binding 与 Codex History，并追加不含正文的 Audit Record。Database Transaction 之后的 Physical Media Cleanup 采用 Best-effort；Result 会返回不含内容的 `mediaCleanupFailures` Count，避免 Filesystem Fault 把已经 Commit 的 Database Purge 误报为可回滚失败。

`bridge profile purge` 与 Archive Purge 分离。它要求 Profile 已 Disabled、无 Live Work，并用完整 Profile ID 确认；它列出 Bridge-owned Path 与 Preserved Path，只删除 Bridge State 和本地 Channel Authentication，保留 Workspace 与 Codex home，并在被删除目录之外留下永久、不含正文的 Profile Tombstone 与 Audit Entry。

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
