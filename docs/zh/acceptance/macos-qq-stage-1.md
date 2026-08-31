# 原生 macOS QQ 验收——阶段一

- 日期：2026-08-31（Asia/Shanghai）
- 候选版本：基于 `a1b7006` 的阶段一工作树
- Host Target：原生 macOS
- Codex CLI：`0.149.1`，已验证 Stable Schema
- Channel：腾讯官方 QQ Bot，私聊

## 无内容结果

1. QQ Adapter 直接契约进入 `ready`，观察到一个真实 Inbound Event，返回一个相关联的 `accepted` Outbound Receipt，桌面客户端显示了回复。
2. 完整的 Supervisor → Profile Worker → Codex App Server → Durable Outbox → QQ 进程树进入 `ready`。两次独立 UI 提交分别生成一条 Archive Record、一条 Terminal Correlation、一个 Logical Result 和一条 Accepted Outbox Record；没有剩余 Pending Delivery。
3. 一个 12 秒 Active Turn 通过 Native Steer 接收第二条消息。两个 Correlation 均变为 Terminal，该 Turn 只产生一个 Logical Result 和一条 Accepted Outbox Delivery。
4. 终止 Profile 自有的 App Server Child 后，观察到 `unavailable(protocol_fault) → ready`，Supervisor 和 QQ Adapter 未停止。
5. 显式应用不存在的 Codex Executable 后，Profile 稳定保持 Unavailable，QQ Adapter 仍在线。真实输入被归档、收到明确的 Unavailable 回复，没有创建 Codex Correlation、没有形成 Outage Backlog，Pending Outbox 为零。
6. 恢复由管理员提供的 Codex Executable 后，同一 Profile 回到 `ready`；下一条真实输入以 Terminal Correlation 和 Accepted Outbox Receipt 完成。
7. SIGINT 产生有界的 Profile `draining → stopped` 转换，并最终产生 `supervisor_stopped` Event。

准备过程中，GUI Harness 曾误提交一次已有的本地剪贴板值。它被识别为独立 Provider Event 和普通 Turn，并通过 Bridge 原生命令中断；它不计入通过场景。本文不保留 Credential、Raw Provider Identity、Provider Message ID、Channel Body、Codex Output 或本地敏感路径。
