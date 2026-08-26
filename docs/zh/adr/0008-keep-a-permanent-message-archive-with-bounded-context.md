# 保留永久 Message Archive 并限制上下文

每个 Profile 将永久保留其 Channel Account 可观察到的 QQ 和 WhatsApp 事件，直至显式删除；这一边界沿用已验证的 snapshot-store 思路，不把近期 Prompt Context 等同于持久历史。Codex Turn 只接收有界的 Context Projection，其中仅包含尚未出现在该 Codex Thread 中的近期 Passive Context Event；更早的记录通过显式命令或由 Codex 调用的结构化与词法 Hybrid Retrieval 获取，而不是在每个 Turn 自动搜索整个 Archive。Codex 仍然独自负责 Thread History 和 Compaction。
