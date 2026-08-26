# Codex 原生 Thread 历史检索与压缩能力核验

- 核验日期：2026-08-26（Asia/Shanghai）
- 本机版本：Codex CLI `0.149.1`
- 官方 tag：[`rust-v0.149.1`](https://github.com/openai/codex/tree/rust-v0.149.1)
- tag 对应 commit：[`ff29a44391deccde0aba0f8390337d7f3c319ea4`](https://github.com/openai/codex/tree/ff29a44391deccde0aba0f8390337d7f3c319ea4)
- 来源范围：OpenAI 官方 `openai/codex` 的上述固定 tag、该版本生成 schema，以及当前官方 OpenAI App Server、配置和 Memories 文档。

> 当前网页文档不按 CLI tag 冻结。下文会把“0.149.1 tag 中存在的实验实现”与“当前官方网页承诺的可用边界”分开陈述；Bridge 不能把源码中存在的实验路径当作稳定产品契约。

## 结论先行

Codex 0.149.1 **原生拥有 Thread 持久化、历史读取、有限的字面正文搜索，以及自动和手动上下文压缩**。升级没有把这些能力变成 BM25/FTS/fuzzy/vector/semantic Hybrid Retrieval，也没有增加每个 Turn 自动搜索所有旧 Thread transcript 的机制。

| 能力 | 0.149.1 核验结果 | Bridge 可否依赖 |
|---|---|---|
| canonical Thread history | 有；durable rollout JSONL | 可以，通过 App Server，不读私有文件/schema |
| SQLite history | 有；paginated Turn/item 的可重建 projection | 不可直接依赖私有表 |
| `thread/read` | 稳定；legacy Thread 可返回完整 turns | 可以，但要按历史模式处理限制 |
| `thread/search` | 实验性；跨 Thread、大小写不敏感的 literal substring | 只能放进 pinned-version compatibility shim |
| `thread/searchOccurrences` | 实验性；单个 paginated Thread 的可见消息逐处匹配 | 首版不可作为必需能力 |
| `thread/turns/list` | 实验性；legacy 路径重放 rollout，paginated 路径读 projection | 首版不可作为必需能力 |
| `thread/items/list` | 实验性；local store 只支持 paginated history | 首版不可作为必需能力 |
| 自动 compaction | 有；达到 token/context 边界及特定模型切换条件时触发 | 应完全交给 Codex |
| `thread/compact/start` | 稳定的手动压缩接口 | 可以投射原生操作 |
| 压缩后旧原文 | 保留在 durable rollout；active model context 被 replacement history 替换 | 不得把 compaction 当作删除 |
| BM25/FTS/fuzzy/vector/semantic Thread search | 没有发现 | 不能声称存在 |
| 自动跨 Thread transcript retrieval | 没有发现 | 不能依赖 |
| Memories | 可选且默认关闭；生成摘要并提供按需本地字面检索 | 是独立 recall 层，不是 transcript Hybrid Retrieval |

最重要的新约束是：当前[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)明确说 `historyMode: "paginated"` 的新建尚不受支持，会返回 JSON-RPC `-32601`；对既有 paginated records，只保证 list 和 summary read，full-history read、Turn pagination 与 resume 在正式支持前 fail closed。虽然 0.149.1 tag 的 local-store 实现和测试已经包含 paginated creation/read/list 路径，但这种“源码存在、公开契约仍不承诺”的矛盾意味着 Bridge 首版必须按**不支持**设计，直到官方文档放开且 pinned binary contract tests 通过。

因此，本项目边界不变，但应更加保守：

- **Codex Thread history**：持久化和 compaction 完全交给 Codex；Bridge 不复制 transcript。
- **Channel Archive**：只保存 Channel/Bridge-owned 事实，并通过 Archive MCP 显式暴露。
- **历史搜索**：稳定路径不能假设存在正文检索；实验性 `thread/search*` 只能是有移除条件的兼容增强，而不是首版 correctness dependency。

## 1. 固定版本与 schema 成熟度

0.149.1 的协议注册中，`thread/compact/start` 没有 experimental 标记；`thread/search`、`thread/searchOccurrences`、`thread/turns/list` 和 `thread/items/list` 均带 `#[experimental(...)]`。[协议注册](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server-protocol/src/protocol/common.rs#L643-L795)

本机 0.149.1 重新生成 schema 的结果也与源码一致：

- 默认 schema 只包含 `thread/compact/start`；
- 使用 `--experimental` 才包含四个 search/pagination 方法；
- 实验方法还要求初始化时声明 `capabilities.experimentalApi = true`，否则 App Server 拒绝。官方文档也明确说明该 opt-in gate。[Experimental API opt-in](https://learn.chatgpt.com/docs/app-server#experimental-api-opt-in)

所以“生成 schema 里看得到”不等于“稳定 API”。

## 2. canonical history 与 SQLite projection

0.149.1 延续了 0.145.0 的核心不变量：

> rollout JSONL 是 durable replay/canonical history；SQLite 是 queryable、可重建且允许落后的 projection/index。

一手证据：

- Local Thread Store 明确把 rollout JSONL 定义为 durable replay format，并说明 live append 仍写 canonical JSONL history。[`local/mod.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/mod.rs#L109-L121)
- 写入顺序是先 durable JSONL，再 materialize SQLite；源码明确写着 “SQLite is a rebuildable view”，失败时可以落后但不能领先 canonical history。[`live_writer.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/live_writer.rs#L283-L365)
- projection 从 durable rollout byte offset 继续读取，只投影完整换行结束的记录。[`thread_history_materialization.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/thread_history_materialization.rs#L18-L69)
- SQLite rows 与 projection checkpoint 在一个事务中推进；SQLite 失败时保持在 durable rollout 之后。[`thread_history.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/thread_history.rs#L99-L208)

准确说法不是“Codex 的会话只存在数据库”，而是：**Codex 持久化 canonical rollout，并维护 metadata/state DB；paginated history 还维护 Turn/item projection。** Bridge 不应查询 Codex 私有 SQLite schema。

## 3. 历史读取与 paginated 可用边界

### 3.1 `thread/read`

`thread/read` 是稳定方法，可不 resume 地读取持久 Thread；`includeTurns: true` 请求 turns。[官方文档](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)

对 legacy Thread，这是首版可以使用的原生读取能力。对 paginated Thread，当前官方文档要求 full-history read fail closed，因此 Bridge 不应以 tag 内部的 compatibility hydration path 作为产品承诺。

### 3.2 `thread/turns/list`

该方法仍是实验性，参数支持 cursor、limit、方向以及 `notLoaded | summary | full` 的 `itemsView`。[协议结构](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1675-L1707)

0.149.1 tag 实现中：

- legacy Thread 每次请求仍完整重放 rollout，再对构造的 Turn list 分页；
- paginated Thread 走 SQLite projection；`full` 暂时由 App Server 再逐 Turn hydrate items。

来源：[`thread_processor.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server/src/request_processors/thread_processor.rs#L2933-L3017)、[paginated path](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server/src/request_processors/thread_processor.rs#L3078-L3146)。

但当前官方文档仍把 paginated Turn pagination 列为 fail-closed，因此这只能作为实现现状记录，不能作为 Bridge 首版依赖。

### 3.3 `thread/items/list`

该实验方法可跨 Thread 分页 items，或用 `turnId` 限定一个 Turn；默认 ascending。[协议结构](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1709-L1748)

Local Thread Store 会先验证 history mode；legacy 返回 unsupported，只有 paginated history 才进入 item projection 查询。[验证实现](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/thread_history/read.rs#L153-L203) App Server 将不支持映射成 `-32601`/`thread/items/list is not supported yet`。[请求处理](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server/src/request_processors/thread_processor.rs#L3292-L3349)

### 3.4 为什么首版必须按 paginated 不可用设计

0.149.1 tag 里已有 local implementation，并有测试接受 `historyMode: "legacy"` 和 `"paginated"`。[tag 测试](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server/tests/suite/v2/thread_start.rs#L474-L503) Local store 也会在 state DB 存在时报告支持列表。[`supports_paginated_history_lists`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/mod.rs#L586-L596)

然而当前官方网页明确给出相反的对外限制。对通用开源 Bridge，选择应是：

1. 默认 `historyMode: "legacy"` 或完全不传该实验字段；
2. 不把 `searchOccurrences`、`items/list` 或 paginated `turns/list` 用于正确性；
3. 如果以后引入 shim，必须 pin CLI 版本、检查 experimental capability、跑创建/读取/resume/list contract tests，并写清移除条件。

## 4. 三种 search 的准确语义

### 4.1 `thread/list.searchTerm`：只过滤标题元数据

`thread/list.searchTerm` 仍是 extracted thread title 的可选 substring filter，而不是消息正文搜索。[协议字段](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1405-L1425) 官方 README 将其定义为大小写敏感的标题 substring。[README](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server/README.md#L421-L446)

### 4.2 `thread/search`：跨 Thread literal 正文搜索

`thread/search` 仍是实验性方法。参数有 cursor、limit、created/updated/recency sort、source kind、archived 和必填 `searchTerm`；仍没有 cwd/Workspace filter，也没有 relevance sort。[协议结构](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1431-L1544)

实现语义是：

- 扫描当前 `CODEX_HOME` 的 active 或 archived rollout root；
- plain JSONL 优先运行 bundled `rg --fixed-strings --ignore-case`；
- 无 `rg` 或 compressed rollout 时走等价的大小写不敏感 escaped literal regex；
- 每个 Thread 返回第一段 user/assistant visible conversation snippet；metadata、reasoning、tool/event、`CompactedItem` 本身不作为 snippet；
- 返回结果按 Thread 时间字段排序，不按匹配相关性排序。

来源：[`rollout/src/search.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/rollout/src/search.rs#L43-L192)、[conversation text 选择](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/rollout/src/search.rs#L238-L305)、[`search_threads.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/search_threads.rs#L33-L108)。

所以协议注释里的 “substring/full-text query” 不能解释成数据库 FTS：这里是“搜索 transcript 正文”的 literal substring，不是 FTS5、BM25、fuzzy、embedding、vector 或 semantic search。

### 4.3 `thread/searchOccurrences`：单个 paginated Thread 的逐处匹配

该实验接口只接受一个 paginated Thread，按 chronological order 返回 occurrence、`turnId`、`itemId`、snippet、UTF-16 range 和可用于 turns/list 的 cursor。[协议结构](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1546-L1596)

SQL 只选择：

1. `item_type = 'userMessage'`；
2. 每个 Turn 的 `final_agent_item_id` 所指 assistant item。

文本层排除图片、音频、skill、mention、plan、reasoning、命令、文件修改、MCP/tool call、web search 和 compaction item。[查询实现](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/thread_history/search.rs#L50-L165)、[文本选择](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/thread_history/search.rs#L304-L350)

0.149.1 增加的主要实现变化是 lineage-aware paging，可跨 paginated rollout lineage 维持 occurrence 与 Turn cursor；匹配算法仍是大小写不敏感 literal substring，并没有升级为 Hybrid Retrieval。

## 5. 自动与手动 compaction

### 5.1 自动 compaction

官方配置 `model_auto_compact_token_limit` 是触发自动历史压缩的 token threshold；`model_auto_compact_token_limit_scope` 控制计算 total 或 `body_after_prefix`。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

0.149.1 在 sampling 前检查配置/模型 auto-compaction budget 与完整 context window；达到限制后运行原生 auto compact。[`run_pre_sampling_compact`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/core/src/session/turn.rs#L1013-L1042)

它还会在以下模型切换边界预先压缩：

- 前后模型 compaction compatibility hash 都存在且发生变化；
- 切换到更小 context-window 模型，且当前 active context 已超过新模型边界。

来源：[`maybe_run_previous_model_inline_compact`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/core/src/session/turn.rs#L1078-L1172)。具体 local/remote/remote-v2 compaction 由 provider capability 和 Codex feature 决定，不属于 Bridge。

### 5.2 手动 compaction

`thread/compact/start` 是稳定方法，立即返回 `{}`；进度走标准 `turn/*`、`item/*` 通知，并产生 `contextCompaction` item lifecycle。[官方文档](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction) Core 的 manual task 根据 provider capability 选择 remote 或 local compact。[`tasks/compact.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/core/src/tasks/compact.rs#L16-L85)

## 6. 压缩后旧历史是否保留

答案仍是：**durable 原文保留；后续模型 active context 被替换。**

压缩完成时 Codex：

1. 用 replacement history 替换内存 active annotated history；
2. 构造包含 replacement history 的 `CompactedItem`；
3. 把它作为新的 `RolloutItem::Compacted` 追加到 canonical rollout；
4. resume 时从最新 compaction checkpoint 重建 model-visible context。

来源：[`replace_compacted_history`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/core/src/session/mod.rs#L3357-L3405)、[resume reconstruction](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/core/src/session/rollout_reconstruction.rs#L312-L367)。

JSONL writer 的 `AppendItems` 明确新增 rollout records；SQLite 只是之后的 projection。[`live_writer.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/thread-store/src/local/live_writer.rs#L283-L365) 因此 compaction 不会删除此前 rollout lines，也不会删除已经投影的旧 Turn/item。旧 visible messages 仍可能被 `thread/search` 命中；对于可用的 paginated projection，旧 visible items 也不因 compaction 自动消失。

只有显式 delete、revert/rollback 的可见历史语义、文件损坏、迁移或外部清理会改变“当前可见历史”边界。不能把 compaction 当作数据保留或删除策略。

## 7. 是否有 Hybrid/语义检索或自动跨 Thread retrieval

### 7.1 Thread transcript：没有

在 0.149.1 的 Thread history/search 路径中没有发现 BM25、FTS5、fuzzy rank、embedding、vector index、semantic search 或 reranking。SQLite history tables 是普通 projection 与分页索引；跨 Thread search 直接扫描 rollout literal；Thread 内 occurrences 使用 literal matcher。

也没有发现 Codex Core 在每个 Turn 前自动调用 `thread/search` 或 `thread/searchOccurrences`。它们是 App Server 收到客户端请求后才执行的显式 API。因此准确说法是：

> Codex 能被客户端要求搜索旧 Thread，但 Codex agent 不会自动把全部旧 Thread 当作 retrieval corpus 查询并注入当前 Turn。

### 7.2 Memories：默认关闭的独立 recall 层

必须把 Memories 与 raw Thread search 分开：

- 官方文档说明 local Codex Memories 默认关闭；启用后会异步把符合条件的旧 chats 生成本地 summaries/durable entries/evidence，并在未来工作中使用。[官方 Memories 文档](https://learn.chatgpt.com/docs/customization/memories)
- 0.149.1 的 memory feature 虽已标记 stable，但 `default_enabled: false`。[feature 定义](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/features/src/lib.rs#L978-L989)
- 启用后，Codex 读取 `memory_summary.md` 并把它与检索指南加入 developer instructions。[`prompts.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/ext/memories/src/prompts.rs#L23-L50)
- Memory extension 只有在 feature enabled 且 `use_memories` 为 true 时贡献 prompt；可选 dedicated tools 默认也不等同于语义检索。[`extension.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/ext/memories/src/extension.rs#L33-L115)
- 本地 memory search 是逐文件、逐行的 substring/归一化匹配与窗口组合，不是 BM25/vector/semantic。[`local/search.rs`](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/ext/memories/src/local/search.rs#L17-L88)、[matcher](https://github.com/openai/codex/blob/ff29a44391deccde0aba0f8390337d7f3c319ea4/codex-rs/ext/memories/src/local/search.rs#L253-L335)

所以 Memories 是“摘要注入 + agent 按需读取/字面搜索”的可选跨聊天回忆层，不是自动搜索 raw Thread database 的 Hybrid Retrieval，也不能保存 Channel provider metadata、媒体、投递与授权事实。

## 8. 对 Channel Bridge 的直接影响

1. Bridge 不复制 Codex Thread transcript，不实现第二套 Thread compaction。
2. 首版只把稳定 `thread/read`、`thread/resume` 和 `thread/compact/start` 视为可依赖的原生边界，并对 pinned schema 做 contract tests。
3. 不要求 `historyMode: "paginated"`；按当前官方合同视为不支持。
4. `thread/search` 可在版本 shim 中作为显式历史查找增强，但必须允许降级；它不能替代 Channel Archive 的 structured/hybrid retrieval。
5. `thread/searchOccurrences`、`thread/items/list` 和 paginated `thread/turns/list` 不进入首版 correctness path。
6. Memories 可由 Profile 的原生 Codex 配置决定；Bridge 不替用户复制或接管它，也不能把它宣传成精确 archive。
7. Channel Archive 仍只保存 Codex 未拥有的 provider event、身份、媒体、投递、去重、授权和未投射 Channel context；Archive MCP 才是 Codex 查询这些事实的显式工具边界。

## 9. 建议的 pinned 0.149.1 contract tests

1. 默认生成 schema 不含四个 experimental search/pagination 请求；`--experimental` 才包含。
2. 未声明 `experimentalApi` 时实验请求 fail closed。
3. 默认 start 不发送 `historyMode: "paginated"`；若开启 shim，先验证当前 binary 的实际返回，并允许立即降级 legacy。
4. `thread/list.searchTerm` 不因正文命中而返回 Thread，且保持大小写敏感标题 substring。
5. `thread/search` 只能做大小写不敏感 literal user/assistant text match；tool-only 命中不产生结果；结果不按相关性排序。
6. `thread/search` 没有 cwd filter；一 Profile 一独立 Codex home 阻止跨 Profile 搜索泄漏。
7. legacy `thread/turns/list` 的 replay 成本不能被误认为 SQLite pagination。
8. `thread/items/list` 和 `thread/searchOccurrences` 对 legacy Thread 返回 unsupported。
9. 手动/自动 compaction 后，下一 Turn 使用 replacement context，但旧 visible messages 仍保存在 rollout，且没有发生 Bridge transcript copy。
10. Bridge Archive 中从未投射给 Codex 的唯一消息不会被任何 `thread/search*` 命中，但能通过 Archive MCP 找到。

## 10. 最终判断

升级到 Codex 0.149.1 后，对“Codex 本身是否具备会话数据库检索和压缩能力”的准确结论是：

- **持久化：有。** canonical durable rollout + metadata/state；实验 paginated mode 还有可重建 SQLite history projection。
- **稳定历史读取：有，但以 legacy Thread 为安全基线。** `thread/read`/resume 由 Codex 管理。
- **正文搜索：有，但仍有限且实验性。** `thread/search` 是跨 Thread literal scan；`thread/searchOccurrences` 是单 paginated Thread literal occurrence search。
- **paginated 可用性：公开合同仍不支持新建。** 不得因 tag 内已有实现就把它纳入首版必要路径。
- **Hybrid/语义检索：没有。** Thread search 不是 BM25/FTS/fuzzy/vector/semantic retrieval。
- **自动/手动 compaction：都有。** 完全属于 Codex-owned behavior。
- **压缩后旧原文：持久保留。** active model context 被替换，compaction 不删除 append-only 原文。
- **自动跨 Thread transcript retrieval：没有。** 可选 Memories 是默认关闭的摘要 recall 层，不是 raw history semantic retrieval。
- **外部 Channel Archive：Codex 不自动拥有。** 仍需要 Bridge-owned storage 与 Archive MCP，但不能复制 Codex transcript。

这支持继续执行 Codex-Native First，同时否定两个过度结论：既不能说“Codex 没有历史和压缩能力”，也不能说“Codex 已原生提供足以替代 Channel Archive 的本地 Hybrid Retrieval”。
