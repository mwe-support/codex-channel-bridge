# 划分 Bridge 与 App Server 的状态所有权

Codex App Server 对 Codex Thread、Turn、执行历史和 Agent 状态具有权威性；Codex Channel Bridge 则对 Profile、Channel Identity、Thread Binding、入站去重、审批路由、Outbox 记录和 Provider 投递状态具有权威性。每个 Profile 在独立数据库中保存自身的 Bridge State，但绝不存储 Codex Thread 正文。Channel 是交互界面而不是工作状态来源，因此 Bridge 不会建立一份与 Codex Conversation History 竞争的副本，同时仍能提供可靠投递和恢复能力。
