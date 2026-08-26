# 分离 Profile Disablement 与永久 Purge

从配置中移除或禁用 Profile 时，将有界 Drain 并停止其 Worker，同时保留数据、Channel Authentication 和 Channel Binding 以便以后恢复；任何配置重载都不能隐式删除或重新分配它们。永久 Purge 是独立的主机本地命令，只能在 Profile 已禁用且没有活动工作时使用，即没有 Active Turn、Queued Input、Pending Approval Request、Pending User-input Request 或 Pending Outbox Delivery；执行前必须预览数量和准确的 Bridge-owned Path，并用完整 Profile ID 确认。Purge 只删除 Bridge-owned State、Message Archive、Media 和本地 Channel Authentication，保留并报告 Workspace 与 Codex home，且不修改 Codex Internal；同时留下不含正文的 Profile Tombstone 和 Audit Record，因为已 Purge 的 Profile ID 永不复用。
