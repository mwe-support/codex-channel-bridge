# 使用 Profile Circuit Breaker 限制 App Server 重启

App Server 退出、启动失败或 stdio 协议损坏时，触发 Profile 本地自动重启，并使用有界 Exponential Backoff 和 Jitter。反复失败时打开 Circuit Breaker，避免无限快速重启；恢复需要经过配置的 Cooldown 并成功完成 Capability Negotiation，或由管理员操作。Circuit 打开时，Profile 拒绝新的 Codex Turn 工作，但仍提供 Channel Status 并投递已提交的 Outbox Record；进程范围内的待处理请求失败，重启恢复则恢复并对账 Codex State，不盲目重放结果不确定的输入。
