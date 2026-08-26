# 在 Profile Worker 内监督 Channel Account

每个 Channel Account 都作为独立受监督的 Adapter Instance 运行，并拥有自己的 Connection State、Retry Backoff、Rate-limit State 和 Health Status。一个 Instance 故障不会停止该 Profile 的其他 Adapter 或 App Server。首版把这些 Instance 保留在 Profile Worker 内，因此承诺的进程故障边界仍是 Profile；如果某个 SDK 表现出进程级不稳定性，可以把它移到子进程边界之后，而无需强制所有 Adapter 使用同样的部署形态。
