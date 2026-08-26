# 默认 Steer 活动 Turn

当 Channel Conversation 已有活动 Codex Turn 时，新的普通消息默认使用 `turn/steer`，而不是静默中断该 Turn 或启动一个相互竞争的 Turn。Profile 可以改用 Queue Mode；如果 Steer 无法应用到准确的活动 Thread 和 Turn，该消息必须保留在队列中并显示状态，不能被重新解释为无关的新 Turn。
