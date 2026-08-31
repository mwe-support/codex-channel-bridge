# 原生 macOS QQ 验收——阶段三

- 日期：2026-08-31（Asia/Shanghai）
- 候选版本：基于 `aee8989` 的阶段三工作树
- Host Target：原生 macOS
- Codex CLI：`0.149.1`，已验证 Stable Schema
- Channel：腾讯官方 QQ Bot，私聊与群聊

## 无内容结果

1. Profile Schema 迁移到版本 7，并为已绑定的 Channel Account 持久化一个
   Profile-local、Session-aware 的 QQ Gateway Transport Checkpoint。一条全新私聊
   Message 完成一个 Codex Turn 和一条 Provider-accepted Outbox Delivery 后，
   Durable Checkpoint 才推进。
2. 一个真实长时 Turn 通过原生 `turn/steer` 接收第二条私聊 Message。最终
   Channel Delivery 只有一个 Logical Result 和一条 Accepted Outbox Record，
   没有形成两个相互竞争的终态回复。
3. Supervisor 完成 Graceful Stop，并从同一 Profile State 重启。官方 SDK 从
   Durable Checkpoint Resume；Message Archive、Codex Input Correlation、
   Logical Result 和 Outbox Record 均未重复。Resume 后的新私聊 Message
   随后正常完成。
4. 一条没有有效 Bot Mention 的真实群聊 Message 被归档，但没有创建 Codex
   Work，也没有产生 Outbound Reply，符合 Passive Group Policy。
5. 在 QQ Client 群聊 `@` 选择器中真实选择 Bot 后，暴露出 Provider Boundary：
   QQ 投递的是带 `mentions[].is_you=true` 的 `GROUP_MESSAGE_CREATE`，不只是
   `GROUP_AT_MESSAGE_CREATE`。Adapter 已修正为识别官方 SDK 的两种表示；
   重复执行真实群聊 Mention 后，一个 Codex Turn 完成并显示预期回复。
6. Deterministic Contract Test 覆盖乱序并发完成、Archive Commit Failure、
   Durable Invalid-session Clear、Restart Restore、HTTP 429 Deferral 和
   Ambiguous Provider Send Outcome。这些是注入式故障测试；本次验收不声称
   腾讯真实触发了 Rate Limit 或 Ambiguous-send Failure。
7. 最终 Durable Count 为：七条 Message Archive Record、五条 Codex Input
   Correlation、四个 Logical Result、四条 Provider-accepted Outbox Record，
   以及一条序号为 10 的 QQ Transport Checkpoint。

本文不保留 Credential、Raw Provider Identity、Provider Message ID、Channel
Body、Codex Output、SDK Session Identifier 或本地敏感路径。
