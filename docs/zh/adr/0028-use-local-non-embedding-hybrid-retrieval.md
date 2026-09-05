# 使用不含 Embedding 的本地 Hybrid Retrieval

Next 修订，2026-09-05 接受：下方信号清单描述当前实现，不是永久算法要求。调整时
对照固定标注集合，覆盖精确匹配、中文子串、错拼、旧记录、结构化范围与无匹配查询，
报告召回/排名、耗时、资源及候选窗口限制。用户接受实测损失前保留既有行为。
2a665ef 消融去掉 fuzzy 后丢失近期错拼目标，因此本次保留全部现有信号。当前 fuzzy
只检查过滤后最近 1,000 个候选；recency 可返回无关兜底记录，其匹配信号用于区分。
这些上限不能被描述为语义检索或全部历史记录的模糊覆盖。

首版将每个 Profile 的永久 Message Archive 保存在一个 WAL 模式的 SQLite 数据库中，由固定版本的 `better-sqlite3` 驱动，并要求启用 FTS5。本地 Hybrid Retrieval 沿用已验证的 Hermes snapshot-store 形态：分别召回消息、Value、Filename 和 Digest 的精确匹配，FTS5 BM25、Substring 与 Fuzzy Text 匹配、Structured Filter 和 Recency，再使用加权 Reciprocal-rank Fusion 融合结果。它不引入 `sqlite-vec`、本地 Embedding Model 或外部 Embedding Provider。这样可以保留混合词法与模糊检索，而无需新增凭据、内容外传、模型下载或第二套推理生命周期；不得把它描述成 Semantic Search 或 Vector Search。

该检索边界只适用于 Bridge 自有的 Message Archive。它不得索引复制的 Codex Transcript、重建 Codex Thread 或执行 Context Compaction。Codex 0.149.1 已经持久化 Thread History，支持稳定的 Legacy-history Read 和实验性的 Literal Body Search，并负责自动与手动 Context Compaction；这些机制仍具有权威性。实验性 Search 和 Paginated-history 方法只是可选的兼容增强，不是首版正确性的依赖。Bridge Index 覆盖 Codex 原生并不拥有的 Channel Fact，包括 Passive Context Event、Provider Identifier 与 Metadata、Media Archive State 和 Delivery Record。固定协议与实现证据见 [`../research/codex-native-thread-history-retrieval-and-compaction.md`](../research/codex-native-thread-history-retrieval-and-compaction.md)。
