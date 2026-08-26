# 每个 Profile 运行一个长生命周期 stdio App Server

每个 Profile Worker 监督一个长生命周期的 `codex app-server` 子进程，并通过原生 stdio JSONL Transport 通信。该 App Server 管理此 Profile 的全部 Codex Thread。首版不会通过 Bridge 自有的 TCP、WebSocket 或 Daemon Listener 暴露 App Server；只有未来原生 Codex Contract 确有需要时，才会重新考虑网络传输。这使信任边界与 Profile 进程保持一致，也避免增加新的远程可访问协议面。
