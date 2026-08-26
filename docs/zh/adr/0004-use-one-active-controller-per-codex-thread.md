# 每个 Codex Thread 只使用一个活动 Controller

由 Bridge 创建的 Codex Thread 是外部 Channel 的主要工作流，Channel Conversation 以后也可以显式绑定到已有的 Codex Thread。同一时间只能有一个 Thread Controller 启动、steer 或 interrupt 该 Thread；`/attach` 会向 Bridge 授予 Control Lease，持续到 `/detach` 或管理员撤销。Codex Desktop 与 Bridge 不会并发写入，因为多个 Controller 竞争时，App Server 连接所有权、审批、事件投递和恢复都会产生歧义。
