# 停止 Bridge 前 Drain 活动 Turn

主动停止、重启或升级 Bridge 时，将进入有界 Drain State：拒绝新的 Turn、Steer 和 Queue Input，但继续接收已有 Turn 所需的 Approval 与 User-input Response，并允许提交其终态 Outbox Record。到达管理员配置的 Deadline 后，Worker 调用原生 `turn/interrupt`，随后优雅终止 App Server，并只在另一个独立超时后才强制终止子进程。Bridge State 会被 Flush；任何未解决 Turn 保持 Uncertain，重启后必须对账，不能假定其成功或失败。
