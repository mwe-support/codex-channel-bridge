# 原生 macOS QQ 验收——阶段四

- 日期：2026-08-31（Asia/Shanghai）
- 候选版本：基于 `b0152c2` 的阶段四工作树
- Host Target：原生 macOS
- Codex CLI：`0.149.1`，已验证 Stable Schema
- Channel：腾讯官方 QQ Bot，私聊限制为一个 Provider-stable Identity

## 无内容结果

1. 实际 Supervisor、Profile Worker、Profile-local Codex App Server 和官方 QQ
   Adapter 从全新的 Owner-only State Directory 启动。Profile 进入 `ready`；
   Capability Negotiation 将 Codex `0.149.1` 识别为 Tested。
2. 从已登录的原生 QQ Client 发送一条真实私聊 Message 后，一个 Codex Turn
   完成，且 Client 显示了完全符合预期的终态回复。随后 Schema Version 8 中
   分别存在一条 Message Archive Record、一条 Codex Input Correlation、一个
   Logical Result 和一条 Provider-accepted Outbox Record。
3. Supervisor 完成 `ready` 到 `draining` 再到 `stopped` 的 Graceful
   Transition，并从同一 Profile State 重启。Profile 重新进入 `ready`，第二条
   真实私聊 Message 也在 Client 中显示完全符合预期的终态回复。
4. 最终 Durable Count 为：两条 Message Archive Record，且对应两个不同的
   Provider Event Identifier；两条 Codex Input Correlation、两个 Logical
   Result 和两条 Provider-accepted Outbox Record。没有遗留 Pending Delivery
   或重复 Durable Record。QQ Delivery 正确保持新增的 WhatsApp-only Quoted
   Reply Column 为空。
5. Deterministic Test 覆盖 Staged Baileys Pairing、Identity Verification、
   Revocation Uncertainty、精确确认的 Local Forget、Lifecycle Quiescence、
   Body-free Audit Record、Request-scoped QR Event Routing 和 Quoted-message
   Reconstruction。本次 QQ Regression Acceptance 未配对真实 WhatsApp Account。

本文不保留 Credential、Raw Provider Identity、Provider Message ID、Channel
Body、Codex Output、QR Value、SDK Authentication State 或本地敏感路径。
