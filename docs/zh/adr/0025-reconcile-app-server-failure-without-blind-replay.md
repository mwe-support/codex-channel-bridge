# 在 App Server 故障后对账而不盲目重放

Profile 的 App Server 故障时，其 Worker 将重启子进程，使用不带 Model 或 Reasoning Override 的 `thread/resume`，并在决定投递内容前对账已绑定 Thread 和 Turn 的状态。结果仍不确定的输入不会自动重放；Channel 会收到明确的 Unknown-state 结果，并可主动重试或继续。来自故障进程的 Server Request（包括待处理审批）会以失败结束，因为其标识符不能复用；已经提交到持久 Outbox 的记录仍可继续投递。
