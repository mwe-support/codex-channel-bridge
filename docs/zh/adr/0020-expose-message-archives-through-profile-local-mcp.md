# 通过 Profile 本地 MCP 暴露 Message Archive

每个 Profile 都通过一个本地、受访问约束的 MCP Server 向 Codex 暴露自身的 Message Archive。Codex 通过原生 MCP 与 Tool Lifecycle 决定何时调用 Archive Search 和 Retrieval Tool；Bridge 不实现并行 Tool Runtime，也不在每个 Turn 中注入无界的 Hybrid Search 结果。Archive Tool 只能访问当前 Profile 拥有的记录，自动 Context Projection 仍单独受限。
