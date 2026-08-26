# 每个部署使用一个 Supervisor Service

每个 Bridge 部署注册一个操作系统 Supervisor Service，由它启动并监控配置的 Profile Worker 子进程；每个 Worker 再监督自己的专属 App Server 子进程。Profile 不会成为独立的 launchd、systemd、Windows 或 Docker Service，因此增加或删除 Profile 仍属于 Bridge Configuration，而不是平台 Service Administration。该 Process Hierarchy 仍会隔离 Worker 故障：一个 Profile 不能终止 Supervisor 或其 Sibling Profile。
