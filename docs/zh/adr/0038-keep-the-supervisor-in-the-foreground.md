# 让 Supervisor 保持前台运行

Bridge Supervisor 始终作为一个前台进程运行，不 Daemonize、不 Fork 到后台、不写 PID File，也不尝试重启自身。平台打包把 launchd、systemd、Windows Service Control 和 Docker Stop Signal 转换成统一的有界 Drain-and-exit Contract，只有平台 Service Manager 决定是否重启 Supervisor。Supervisor 继续在内部重启 Profile Worker，使这种子进程监督与主机 Service Recovery 保持分离，避免嵌套 Restart Loop。
