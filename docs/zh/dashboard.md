---
title: 本地 Dashboard
---

# 本地 Dashboard

可选 Dashboard 会显示正在运行的 Bridge 版本、Host Liveness、Configuration
Revision、Profile Readiness，以及各 QQ 或 WhatsApp 账号的连接状态；同时提供现有
Configuration Plan/Apply 流程。

通过 Owner-only 本地 Control Socket 启动：

```sh
bridge dashboard --endpoint /absolute/path/control.sock
```

该命令只在 `127.0.0.1` 的临时端口监听，并输出随机且仅本次启动有效的 URL。请只在
同一 Host 打开，并将其视为 Administrator Capability：不要分享或写入日志。按
Ctrl-C 会停止 Dashboard 并使 URL 失效。不支持 LAN、Public、Unattended 或
Multi-user Access。

## 设置

输入现有 `config.yaml` 的绝对路径，选择 **Plan** 并检查脱敏结果。成功生成 Plan
后才会启用 **Apply**，且必须输入完整 Candidate Revision。Dashboard 通过
`bridge config plan` 与 `bridge config apply` 使用的同一个 Host-local Control
Plane 执行操作；不会直接写 Profile Database、Worker、Secret 或配置文件。

## Operational Event

最近事件是一个有界且不含内容的列表，只记录本次 Dashboard 启动后观察到的状态变化
和 Dashboard 操作。它不替代 launchd、journald、Windows Service 或 Docker
日志。Dashboard 不读取 Channel 消息正文、Codex 内容、Message Archive、Codex
Home 或 Workspace 文件。

不需要浏览器时，`bridge status` 也会返回同一个权威 `bridgeVersion` 字段。
