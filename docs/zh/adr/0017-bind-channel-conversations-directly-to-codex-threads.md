# 将 Channel Conversation 直接绑定到 Codex Thread

Bridge 不重建 Hermes 风格的 Session，也不从 Channel Routing Key 推导文件系统 Project。每个 Profile 有一个 Workspace，每个 Channel Conversation 有稳定的 Conversation Key，其当前 Thread Binding 直接指向一个 Codex Thread；`/new` 用新的原生 Thread 替换该 Binding，`/attach` 则选择已有的原生 Thread。对于群聊，`group_thread_scope: conversation` 让整个群共享该 Binding，`group_thread_scope: participant` 则为群内每个 Provider Identity 派生独立 Binding；默认值是 `conversation`。Approval Correlation 始终保留发起实际 Codex Turn 的 Provider Identity。Thread 边界以下的全部 History 和 Context Lifecycle 均由 Codex 所有。
