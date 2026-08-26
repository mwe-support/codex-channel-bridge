# 承诺 Channel 的 Effectively-once 投递

Bridge 将通过 Provider Event Identity、Codex Input Correlation、持久 Outbox、Logical Result Identity、Segment Identity 和重启对账，实现 Effectively-once 处理与最终投递。如果 Provider 可能已经接受发送，却既不提供幂等键也无法对账，Bridge 将优先保证投递，并使用同一个 Logical Result 重试，接受一个很小且可见的重复窗口，而不是静默丢失终态结果。项目不会宣称具备严格的 Exactly-once 行为。
