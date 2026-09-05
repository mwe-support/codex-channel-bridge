---
title: 架构与职责
---

# 架构与职责

## 进程边界

一个部署只运行一个前台 Supervisor。它为每个启用的 Profile 管理一个 Worker；
每个 Worker 管理一个由管理员提供的 Codex App Server 子进程，并独立监管 Channel
Adapter。不同 Profile 不共享 App Server、Codex Home、Workspace、状态数据库、媒体
目录或 Channel Account。

```text
service manager
  -> Bridge Supervisor
       -> Profile Worker
            -> Codex App Server (stdio JSONL)
            -> QQ adapter
            -> WhatsApp adapter
```

App Server 通过本地 stdio 连接，管理操作使用 Owner-only Local IPC。可选本地
Dashboard 按 ADR 0053 仅绑定回环地址，并将操作转发到相同 IPC；不开放远程管理。

## 职责归属

| 所有者 | 权威状态 |
| --- | --- |
| Codex App Server | Thread、Turn、Item、历史、压缩、审批、沙箱、权限、模型、工具、Skill、MCP、Codex 认证 |
| Bridge | Profile、Channel Account 与 Binding、Access Policy、Provider 归一化、Thread Binding ID、Message Archive、输入关联、Durable Outbox、投递回执 |
| Channel Provider | Provider Message、Participant 和 Conversation 标识、发送响应及其暴露的事件 |

Bridge 使用原生 App Server 生命周期：`thread/start` 创建 Thread，`thread/resume`
加载已有 Binding，`turn/start` 开始工作，`turn/steer` 向活动 Turn 追加输入，
`turn/interrupt` 停止工作。Bridge 不会重建这些语义。参见
[App Server 官方文档](https://learn.chatgpt.com/docs/app-server)。

## Package 分布

- `core`：共享契约、命令、访问与准入词汇。
- `config` 与 `profile-store`：经过校验的 Bridge 配置和 Profile 本地 SQLite Store。
- `codex-app-server` 与 `profile-worker`：原生协议边界和 Profile 生命周期组合。
- `qq-adapter` 与 `whatsapp-adapter`：Provider 特有事实与回执。
- `supervisor`、`control-plane` 与 `cli`：部署生命周期和本地主机管理。

实现与契约测试说明见[开发指南](development.md)。
