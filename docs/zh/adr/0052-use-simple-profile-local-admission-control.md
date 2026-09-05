# 使用简单的 Profile 本地 Admission Control

`0.2.0-rc.1` 修订，2026-09-04 接受（FR-003）：不同 Thread 默认不设置 Bridge 并发上限。
`maximumActiveTurns: null` 表示无限制准入，管理员仍可显式设置有限上限。
这取代下方原始决策中的强制上限，不改变同 Thread steer/queue、速率限制、
磁盘保护或权限校验，不引入额外调度系统或 Gateway。

首版为每个 Profile 设置最大 Active Turn 数量、一个仅在 Ready 状态下由显式 Queue Mode 使用且受 Size/Age 限制的 FIFO，以及简单的 Per-channel-account Admission Rate。队列已满时以 `busy` 明确拒绝最新输入；过期 Entry 会被报告且永不执行；Steer Mode 不建立普通消息队列。固定优先级依次处理 Approval 或 User-input Response、已提交 Outbox Delivery、Active-turn Control 和 New Turn，并对 Profile 进行简单 Round-robin Scan。Provider Backoff 保持在 Adapter 内；发生 Storage Pressure 时，先拒绝 New Work 和 Media Mirroring，再以 `unavailable: storage_pressure` 断开受影响 Adapter，避免不安全归档。这一设计有意避免通用 Scheduler、Broker、Distributed 或 Hierarchical Quota，以及内置 CPU/Memory Isolation；强 Resource Security 仍由部署负责。
