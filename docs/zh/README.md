---
sidebar_position: 1
slug: /
title: Codex Channel Bridge
---

# Codex Channel Bridge

Codex Channel Bridge 是连接 QQ 或 WhatsApp 与 Codex App Server 的自托管适配
层。通过它，获准的 Channel Conversation 可以在隔离的 Profile 内创建、恢复、
引导原生 Codex Thread，并接收结果。

Bridge **不是 Agent Gateway**。Thread、Turn、历史、上下文压缩、审批 schema、
沙箱与权限策略、模型、工具、Skill、MCP 和认证均由 Codex 管理。Bridge 只管理
Channel 访问、Provider Event 归一化、Conversation 到 Thread 的绑定、投递关联、
Durable Outbox 重试，以及仅属于 Channel 的 Message Archive。

## 从这里开始

- [快速开始](getting-started.md)：构建并运行当前候选版本。
- [架构与职责](architecture.md)：运行前先理解进程与状态边界。
- [配置](configuration.md)：定义 Profile、Workspace、Channel Account、Access
  Policy 和 Secret Reference。
- [Channel 命令](commands.md)：从 QQ 或 WhatsApp 投射 Thread、Turn、模型、
  推理强度和审批操作。
- [发布状态](release-status.md)：区分已验收能力、精确 tag 复验缺口与未来工作。
- [限制与路线图](limits-and-roadmap.md)：查看刻意延期的能力和平台边界。

## 文档版本

`Next` 描述持续变化的 `main`，不是正式发布。版本选择器还提供从对应 Git tag
生成的不可变候选发布文档。在首个稳定版本出现前，不提供 `latest` 路由。
`/version-manifest.json` 构建清单记录源 commit、tag、产品版本、文档版本、发布日期
和归档校验和。

每一份公开英文页面都在 `docs/zh` 的相同相对路径下有语义一致的中文版；可通过
语言选择器切换。
