# 将 Channel 直接连接到 Codex App Server

本项目将作为一个独立的 Codex Channel Bridge，由自身的 Channel Adapter 把 Channel Conversation 直接连接到 Codex App Server。现有 Hermes 的 QQ、WhatsApp 和 Codex 插件仅作为研究资料：Hermes、OpenClaw 及其他通用 Agent Gateway 均不是运行时依赖，因为 Bridge 必须自行负责 Channel 路由、持久投递以及原生 Codex 生命周期和审批的传输，而不是继承其他 Gateway 的 Session 模型。独立性也包括仓库谱系：新的 `main` 历史不保留任何 Hermes commit、branch、tag、remote、CI、部署资源、插件代码或运维文档，并以本项目的权威设计、研究、许可证和新编写的项目文件为起点。以后若复用遗留源码，必须逐文件审查许可证并在 NOTICE 中注明归属，不能因为源码曾出现在探索性 worktree 中就推定获得了使用许可。
