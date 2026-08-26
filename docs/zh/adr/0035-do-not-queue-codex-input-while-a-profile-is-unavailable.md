# Profile Unavailable 时不排队 Codex Input

当 Profile 无法使用其 App Server 时，Channel Event 仍经过 Access Policy、Deduplication 和 Message Archive Retention，本地只读 Help 或 Status Command 也可继续使用。任何会启动、steer、interrupt 或排队 Codex Work 的输入都会收到明确的 Unavailable Response，且不会加入 Outage Backlog。恢复后绝不自动执行这些已拒绝的消息，因为持久归档只记录 Channel 暴露过的内容，并不代表同意以后运行一条过期指令。
