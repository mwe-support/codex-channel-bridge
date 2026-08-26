# 分层控制群 Conversation 与 Participant 访问

群聊准入将评估两项独立的 Access Policy：第一项选择哪些群 Channel Conversation 可以进入 Profile，第二项选择已准入群中的哪些 Provider Identity 可以触发 Codex。Private Chat Identity 使用自己的策略。增加这部分配置是为了能够同时表达“只允许这个群”和“群内只允许这些参与者”，避免仅因其中一方受信任就自动授权另一方。
