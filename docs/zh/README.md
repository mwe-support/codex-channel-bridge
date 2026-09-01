# 文档中心

当前文档版本记录在 [`VERSION`](VERSION)。`main` 分支上的文档描述下一个待
发布版本，内容可能继续变化。部署某个已发布版本时，必须使用对应
`vMAJOR.MINOR.PATCH` Git tag 内或该 GitHub Release 附带的文档，不能用
`main` 文档指导旧版本运行。

## 部署与运维人员

新部署建议按以下顺序阅读：

1. [`deployment.md`](deployment.md)：选择固定 tag，并在 macOS、Linux 或
   Linux Docker 上安装前台 Supervisor。
2. [`configuration.md`](configuration.md)：配置 Profile、Workspace、Channel
   Account、Access Policy、Secret Reference 并完成校验。
3. [`qq-adapter.md`](qq-adapter.md) 或
   [`whatsapp-adapter.md`](whatsapp-adapter.md)：开通所需 Channel。
4. [`operations.md`](operations.md)：执行健康检查、doctor、备份保持、Audit
   Record、Support Bundle 和 circuit 恢复。
5. [`migrations.md`](migrations.md)：升级到包含 Profile 数据库 schema 变更的
   Bridge 版本前必须阅读。

投递、准入、审批和归档行为分别由 [`delivery.md`](delivery.md)、
[`admission.md`](admission.md)、[`approval-routing.md`](approval-routing.md)
和 [`message-archive.md`](message-archive.md) 说明。

## Channel 用户与 Profile 管理员

- [`thread-binding.md`](thread-binding.md) 说明 Channel Conversation 到 Codex
  Thread 的绑定，以及 `/new`、`/attach`、`/detach`、`/model` 和
  `/reasoning` 的原生投射。
- [`approval-routing.md`](approval-routing.md) 说明谁可以回答 Codex Approval
  Request，以及过期请求如何失败关闭。
- QQ 与 WhatsApp Adapter 文档分别说明各平台私聊、群聊、回复、@、媒体与认证
  的准确边界。

## 贡献者与二次开发者

先阅读 [`../../CONTEXT.md`](../../CONTEXT.md)，再阅读
[`development.md`](development.md)，了解包职责、本地环境、契约测试、扩展路径
与完成门禁。不可逆架构决策在 [`adr/`](adr/)；研究快照只作为证据，不是运行
契约。

版本变更、变更日志、候选发布、tag、不可变制品和文档版本规则见
[`release.md`](release.md)。`docs/` 下每一份英文文档，都必须在 [`zh/`](.)
下具有相同相对路径且语义一致的中文版。
