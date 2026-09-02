---
title: 限制与路线图
---

# 限制与路线图

## 首版限制

- 共享 OS User 的 Profile 只提供应用层隔离，不是恶意进程隔离。需要更强隔离时，
  应使用独立 OS User 或 Container。
- 管理只通过本地主机 Structured IPC 完成。没有 Web Console、远程 App Server
  Attach 或管理 TCP 端口。
- 投递目标是 Effectively-once。QQ 和 WhatsApp 没有通用 Idempotent Send 契约，
  因此 Provider 发送结果不明确时存在很小的重复窗口。
- Local Hybrid Retrieval 使用 SQLite FTS5、精确、子串、模糊、结构化和时效信号，
  不依赖 Embedding 或外部搜索服务。
- Restore 只支持兼容路径与相同 OS Family，不会改写 Codex 历史来伪造可移植性。
- 发布机制提供源码归档与校验和，不发布 npm Package 或 Registry Container Image。

## 未来工作

- 指定真实 Windows 验证主机后，完成原生 Windows Service 与 Named-pipe ACL
  验收。
- 对[发布状态](release-status.md)中列出的 Provider 和 Linux 边界执行精确 tag 复验。
- Web 管理 UI 只有在认证、授权、生命周期以及本地/远程信任边界通过独立设计验收
  后才会实现。

搜索分析、自动翻译、Dynamic Adapter Plugin Runtime、外部 Vector Backend 或
Telemetry Backend 都不是首版的计划前置条件。
