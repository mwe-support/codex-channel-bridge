# 保留 Profile 数据直至显式 Purge

禁用或通常意义上的删除 Profile 时，仍保留其可恢复的 Message Archive 和投递状态，因此“永久”表示保留到管理员主动执行主机本地操作，而不是永远无法删除。Profile Purge 与 Archive Purge 必须保持分离，任何 Channel 命令或自动保留策略都不得删除 Archive 内容；首版的 Archive Purge 只支持两个范围：一个 Profile 的整个 Archive，或一个准确 Channel Conversation 中早于指定时间的记录。执行前必须预览范围、数量、媒体字节和活动引用，并用 Profile ID 与预期数量确认。任何活动 Turn、队列、审批或 Outbox 引用都会拒绝整个操作；否则在一个事务中删除基础行和 FTS 条目，只回收未被引用的 Content-addressed Media，Binding 和 Codex History 保持不变，并用不含正文的 Audit Record 记录范围、数量和被删除集合的摘要。
