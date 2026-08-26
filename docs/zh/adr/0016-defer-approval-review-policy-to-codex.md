# 将 Approval Review Policy 交由 Codex

Bridge 不定义并行的 Approval Policy：每个 Profile 都使用 Codex 的 Reviewer 行为。由 Codex 自行解决的请求保留在 Codex 内部；App Server 发送给 Bridge 的 Approval Request 则展示给具有控制权的 Channel Participant，并在原始 Server Request 上返回答复。Bridge 绝不把审批文本转换成另一个 Codex Turn。
