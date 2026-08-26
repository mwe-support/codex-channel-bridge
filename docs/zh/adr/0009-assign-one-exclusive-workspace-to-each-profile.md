# 为每个 Profile 分配一个专属 Workspace

每个 Profile 恰好拥有一个 Workspace，并且默认情况下，不同 Profile 不能通过 Bridge 配置访问彼此的 Workspace。这牺牲了按 Conversation 灵活切换项目的能力，换取更简单的隔离和路由模型：Channel Conversation 继承所属 Profile 的 Workspace，不能提交任意文件系统路径。
