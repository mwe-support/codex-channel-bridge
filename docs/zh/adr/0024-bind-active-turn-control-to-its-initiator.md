# 将活动 Turn 的控制权绑定到发起者

在共享 Thread Binding 的群聊中，只有 Turn Initiator 可以 steer 或正常停止活动 Turn，并回答其 Approval Request 或 User-input Request。其他已准入 Participant 遵循 Profile 的 Busy-input Policy，不能接管该 Turn。Profile Administrator 可以执行留下审计记录的紧急停止，但不能代表发起者审批或回答。下一个被接受的 Turn 会建立新的 Turn Initiator，但不改变 Thread 的所有权或历史。
