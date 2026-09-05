# 模型与思考强度查询——Next 验收

日期：2026-09-04。本机原生 macOS 工作区部署，Bridge `0.1.0-dev`，
使用管理员提供的 Codex `0.149.1`。尚未分配发布版本/tag。
范围为 FR-007，不重置其他流式或平台验收门槛。

## 原生契约与检查

复用 `readThreadSettings`，仅传 `threadId` 调用 `thread/resume`。
本机生成的 `ThreadResumeResponse` 提供 `model` 及可空 `reasoningEffort`；
上游响应来自 Thread 配置快照。查询不传覆盖设置、不写配置、不推测模型目录默认值，
不创建模型 Turn。原生 resume 可能加载未加载的 Thread。
参见 [App Server 官方文档](https://developers.openai.com/codex/app-server)。

- `npm test`：238 项单元测试、4 项发布工具测试、4 项平台文件契约测试通过。
- 原生 `npm run test:contract`：Codex 0.149.1 通过，schema SHA-256 为
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`。
- 回归覆盖无参数/尾部空白查询、带参数切换、未绑定、空强度、共享群聊查询与修改权限，
  以及缺少实验性设置更新能力时仍可查询。
- 真实群聊发现 SDK 1.0.4 按 AppID 清理时漏掉开头的不透明 QQ 提及标记。
  适配器到核心解析器的回归测试修复前失败、修复后通过。仅清理提供商已确认对 Bot
  发起的群聊事件的开头提及；未提及事件、私聊及正文中间的提及保持不变。
  命令解析与权限判断仍在核心/Worker 完成。

## 真实 QQ 客户端结果

通过本机已登录 QQ 客户端向配置的测试 Bot 发送查询和切换命令；
群聊命令使用真实成员提及选择器。

| 场景 | 原生回复 / 结果 |
| --- | --- |
| 私聊 `/model`、`/reasoning` 基线 | `gpt-5.6-luna`、`high` |
| 私聊 `/reasoning low` 后查询 | 修改成功，查询返回 `low` |
| 私聊模型切换与回查 | 使用完整模型 ID 完成 `luna → sol → luna`，每次回查都反映修改 |
| 独立群聊基线 | `gpt-5.6-sol`、`high` |
| 私聊修改模型/强度后回查群聊 | 私聊为 `luna / low` 时，群聊仍为 `gpt-5.6-sol / high` |
| 恢复私聊设置 | `gpt-5.6-luna`、`high` |

群聊和私聊持久绑定两个不同的 Codex Thread ID。成功查询的记录没有 Codex input
correlation，不会启动模型 Turn。首次修复前由模型生成的群聊回答不计为查询验收。
Supervisor 与 QQ/WhatsApp 两个适配器均就绪；有界重启期间保留 Dashboard，
本功能不需要 schema 迁移。

本次验证同一 Profile 的两个 QQ 会话，不代表所有提供商/平台组合。
设置属于原生 Thread：如果多个会话刻意绑定同一个 Thread，则共享该 Thread 的设置。
本记录不声称新增 WhatsApp、Linux、Docker 或 Windows 真实测试。
