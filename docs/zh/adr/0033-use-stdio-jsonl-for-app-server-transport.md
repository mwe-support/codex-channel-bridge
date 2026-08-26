# 使用 stdio JSONL 作为 App Server Transport

首版中，每个 Profile Worker 仅通过本地 stdio 上以换行分隔的 JSON 与受监督的 App Server 子进程通信。Stdout 只承载协议，任何非协议输出都视为故障；Stderr 则单独捕获为有界、经过脱敏的诊断。这能在 macOS、Linux、Windows 和 Docker 上提供一致的私有子进程传输，无需 Listener、Transport Authentication、Socket Cleanup 或平台专属 Endpoint 管理；Unix Socket、Named Pipe 和 WebSocket 必须由未来 ADR 决定。
