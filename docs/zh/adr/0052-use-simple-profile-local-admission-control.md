# 使用简单的 Profile 本地 Admission Control

Next 修订，2026-09-05 接受：保留一个有界队列，在同一 Thread Binding 内保证 FIFO。
启动最早可执行项，跳过被自身活动 Thread 阻塞的工作，让独立工作使用空闲额度。
保留队列年龄、容量、发起人校验、账户速率、故障期间不积压和有界排空。活动 Channel
上下文与 Turn 目标共同存储；验证晋升、排空和释放期间控制者及账户计数的一致性。

各 Profile 独立执行，不设中央工作调度器。复用 Outbox，让各 Channel Account 独立
领取和发送；按账户领取不得回收其他账户仍在使用的租约。保留 Logical Result 分段
顺序与持久重试。Adapter 解释平台错误/提示，Outbox 以有界退避持久化重试时刻。
验证发送阻塞、单账户占满批次、后续到达、顺序、重启和排空。这取代下方原始决策的
全局 FIFO、跨 Profile 轮询及重试位置表述，不引入外部 Broker 或通用调度系统。

`0.2.0-rc.1` 修订，2026-09-04 接受（FR-003）：不同 Thread 默认不设置 Bridge 并发上限。
`maximumActiveTurns: null` 表示无限制准入，管理员仍可显式设置有限上限。
这取代下方原始决策中的强制上限，不改变同 Thread steer/queue、速率限制、
磁盘保护或权限校验，不引入额外调度系统或 Gateway。

首版为每个 Profile 设置最大 Active Turn 数量、一个仅在 Ready 状态下由显式 Queue Mode 使用且受 Size/Age 限制的 FIFO，以及简单的 Per-channel-account Admission Rate。队列已满时以 `busy` 明确拒绝最新输入；过期 Entry 会被报告且永不执行；Steer Mode 不建立普通消息队列。固定优先级依次处理 Approval 或 User-input Response、已提交 Outbox Delivery、Active-turn Control 和 New Turn，并对 Profile 进行简单 Round-robin Scan。Provider Backoff 保持在 Adapter 内；发生 Storage Pressure 时，先拒绝 New Work 和 Media Mirroring，再以 `unavailable: storage_pressure` 断开受影响 Adapter，避免不安全归档。这一设计有意避免通用 Scheduler、Broker、Distributed 或 Hierarchical Quota，以及内置 CPU/Memory Isolation；强 Resource Security 仍由部署负责。
