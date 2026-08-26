# 使用本地 IPC 管理并推迟 Web Console

首版管理使用结构化 Host-local IPC：在 macOS、Linux 和 Docker 上使用 Owner-only Unix Domain Socket，在 Windows 上使用受严格 ACL 保护的 Named Pipe；在平台支持时验证 Peer Identity，并对每个操作授权。CLI 使用该控制平面进行 Status、Diagnostic、Profile Management 和 Backup Coordination；Docker Operator 在容器内运行 CLI。首版不提供 TCP 或 HTTP 管理 Endpoint。Web Administration Console 仍是未来规划能力，但实现前必须由独立 ADR 定义 Authentication、Authorization、TLS、Browser Security、Audit 和 Network Exposure。
