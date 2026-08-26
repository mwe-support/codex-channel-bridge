# 每个 Profile 监督一个 App Server 子进程

每个 Profile Worker 使用管理员提供的 Codex Executable 启动并监督一个专属 Codex App Server 子进程。首版不让多个 Profile 共享一个 App Server，也不连接管理员运行的远程 App Server，因为这会削弱 Profile Ownership、Codex home、Workspace、Authentication、Capability Negotiation、Failure Recovery 与 Process Lifecycle 之间的一致性。一个 Profile 的子进程故障仍与其他 Profile Worker 隔离。
