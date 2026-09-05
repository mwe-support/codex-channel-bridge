---
title: macOS WhatsApp 模拟流式验收
---

# macOS WhatsApp 模拟流式验收

日期：2026-09-04，Asia/Shanghai。范围：FR-001，Next，**部分验收**。
本报告不代表已发布或已提交。

历史快照：2026-09-04 稍后用户将流式预览调整为原生等待状态与完整回复。
以下结果不代表替代实现通过验收，参见 [FR-001](../feature-requirements.md)。

## 部署

- 原生 macOS，真实已关联的 WhatsApp 测试账号与已登录桌面客户端。
- 基础提交：`4a655d34b038d33b3b53eb8af099ca0b8c03f9c6`，叠加尚未提交的
  FR-001 实现。Codex CLI `0.149.1`，Baileys `7.0.0-rc14`。
- Supervisor 与 Adapter 均报告 ready；通过仅进程生效的环境覆盖以 1000 毫秒
  间隔开启预览。未修改凭证、配对或 Access Policy。
- 本功能 12 个生产源码文件的聚合 SHA-256 为
  `57499fee14229169b12124cc63edc2c6b9ad2918f6d601ef44dc227d0f355c13`。
  它只标识功能源码，不代表完整部署或发布产物。

摘要范围：`packages/core` 下的 `src/channel-adapter.ts`、`src/index.ts`；
`packages/config` 下的 `src/config.ts`；`packages/cli` 下的 `src/setup.ts`；
`packages/codex-app-server` 下的 `src/protocol-schema.ts`；
`packages/profile-worker` 下的 `src/codex-event-router.ts`、
`src/turn-coordinator.ts`、`src/conversation-turn-coordinator.ts`、`src/profile-worker.ts`；
以及 `packages/whatsapp-adapter` 下的 `src/text-preview.ts`、
`src/whatsapp-adapter.ts`、`src/whatsapp-channel-account.ts`。
按仓库相对路径字典序排序，逐个将路径、NUL、文件字节、NUL 输入摘要。

## 真实交互结果

用户在操作时确认了此次 UI 发送。通过 Computer Use 发送两条不含敏感信息的
编号文本请求：先私聊，再在已授权测试群测试。群聊通过提及菜单选择真实成员，
不是普通文本形式的 `@` 名称。

| 检查 | 私聊 | 群聊 |
| --- | --- | --- |
| 真实入站进入 Codex Turn | 通过 | 通过 |
| 桌面端看到带标签的预览 | 通过 | 通过 |
| Provider 编辑可见 | 部分文本从约第 27 行增长到第 54 行 | 观察到增长至第 30 行的已编辑预览 |
| 独立最终回复可见 | 通过 | 通过 |
| 原生终态 | completed | completed |
| 最终 Outbox 状态 / 尝试次数 | accepted / 1 | accepted / 1 |
| 最终编号行数 / 最后编号 | 80 / 80 | 80 / 80 |
| 最终文本大小（SQLite 字符数） | 2035 | 2370 |
| 预览标签被存为最终输出 | 否 | 否 |

只读 SQLite 检查关联两条有标记的入站测试记录、Input Correlation 和最终 Outbox，
仅报告数量、终态、投递状态与文本形状检查。两个输入使用两个不同的 Codex Thread。
这是顺序执行的真实交互，不是同时运行的真实并发测试。本报告不包含消息正文、
Provider 标识或认证材料。

## 自动验证与剩余门槛

此前实现检查：`npm test` 通过 231 项单元测试、4 项发布工具测试和 4 项平台
契约测试。宿主环境中的 `npm run test:contract` 在 Codex 0.149.1 上通过
（沙箱内首次尝试遇到 App Server stdout 关闭）。另一次真实无工具原生 Turn
收到 5 次文本增量并返回预期最终结果。`npm run docs:build` 两种语言均通过。

FR-001 完成/提交前仍需：

- 真实长任务生命周期/编辑期限降级；本次回复未达到本地 10 分钟预览期限。
  定时器/失败单元测试不能替代 Provider 实际过期行为的证据。
- 仓库要求的真实 macOS QQ 共享路由回归。

测试 Supervisor 继续运行，保留仅进程生效的预览覆盖；不携带此覆盖重新启动时，
恢复配置中的默认仅最终回复行为。
