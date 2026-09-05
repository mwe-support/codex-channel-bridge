---
title: 限制与路线图
---

# 限制与路线图

## 首版限制

- 共享 OS User 的 Profile 只提供应用层隔离，不是恶意进程隔离。需要更强隔离时，
  应使用独立 OS User 或 Container。
- 管理权威状态仍只通过 Host-local Structured IPC 提供。Dashboard
  只是它的本地适配器；远程 App Server Attach 和远程管理仍不受支持。
- 投递目标是 Effectively-once。QQ 和 WhatsApp 没有通用 Idempotent Send 契约，
  因此 Provider 发送结果不明确时存在很小的重复窗口。
- Local Hybrid Retrieval 使用 SQLite FTS5、精确、子串、模糊、结构化和时效信号，
  不依赖 Embedding 或外部搜索服务。
- Restore 只支持兼容路径与相同 OS Family，不会改写 Codex 历史来伪造可移植性。
- 发布机制提供源码归档与校验和，不发布 npm Package 或 Registry Container Image。

## 已纳入 `0.2.0-rc.1`

- 提供官方维护的一条命令原生安装器与原子 Bridge 升级；校验不可变 Release
  Checksum，且绝不安装或升级 Codex。
- 提供 `bridge setup quick` 与 `bridge setup full`；两者都生成现有校验与应用
  流程接受的 Canonical Configuration。
- 提供仅绑定 Loopback 的 Dashboard，通过现有 Control Plane 查看运行中的 Bridge
  版本、Health、Channel Connectivity、有界且不含内容的 Event，并执行需确认的
  Configuration Plan/Apply 操作。
- 原生 Windows 已完成 Installer、Setup、Build、Named-pipe Request、Dashboard
  与版本显示的应用层验收。
- Windows Control Pipe 由 Helper 持有，并验证只允许 Service Identity、
  LocalSystem 与 BUILTIN\Administrators 的 Protected DACL。

## 未来工作

新增功能需求与验收进度记录在[功能需求清单](feature-requirements.md)中，
与已发布版本的可用性分开维护。

- 在指定 Windows Host 上完成随 Release 提供的 Windows Service 安装，以及严格
  State、Secret 与 Baileys ACL Enforcement；一次性 WinSW Lifecycle 与严格
  Control-pipe ACL 验收已经通过。
- 对[发布状态](release-status.md)中列出的 Provider 和 Linux 边界执行精确 tag 复验。

搜索分析、自动翻译、Dynamic Adapter Plugin Runtime、外部 Vector Backend 或
Telemetry Backend 都不是首版的计划前置条件。
