---
title: 发布状态
---

# 发布状态

## 版本

| 文档 | 产品 | 来源 | 状态 |
| --- | --- | --- | --- |
| Next | `0.1.0-dev` | 当前 `main` 构建 commit | 未发布且会变化 |
| `0.1.0-rc.4` | `0.1.0-rc.4` | tag `v0.1.0-rc.4`，commit `bf3b583f1c877cf80ff3fb77c104653eb4df5d70` | 已发布候选版本，不是稳定版本 |

该候选版本于 2026-09-02 发布。[GitHub Release](https://github.com/mwe-support/codex-channel-bridge/releases/tag/v0.1.0-rc.4)
归档 SHA-256 为
`c99afaed120148b5ca06da13e62de672911d7033049cd6e5d4352154c145cf70`。
不可变的 `rc.1`、`rc.2` 和 `rc.3` tag 是 CI 失败候选，没有发布 GitHub Release。
当前不存在稳定版本，也没有 `latest` 别名。

## 验收边界

| 状态 | 范围 |
| --- | --- |
| 已实现且已验收 | 原生 macOS Supervisor 生命周期；真实 QQ 私聊往返；`/help`、`/status`、`/new`、`/model`、`/reasoning`；原生 Codex 协议；Owner-only Unix Control Plane；rc.4 确定性发布门禁。 |
| 已在当前 `main` 实现，但 rc.4 不包含 | 校验 Release Checksum 的原生安装/升级脚本；生成规范配置的快速/完全交互式设置；仅绑定 Loopback、显示运行 Bridge 版本、Health、Channel Connectivity、无内容 Event 并执行需确认设置变更的 Dashboard；`bridge --version`；本地 POSIX/macOS 与原生 Windows 应用层验收。 |
| 已实现，但 Runtime Refactor 后未按精确 rc.4 tag 复验 | 真实 WhatsApp 私聊、群聊与重启；原生 Linux systemd 生命周期；Linux Docker 非 root、Health、无公开端口与优雅停止。 |
| 已实现且有低于真实 Channel 的测试覆盖 | `/attach` 原生 Binding 与 Workspace 校验；rc.4 验收未通过真实 QQ 客户端执行。 |
| 已规划或未验证 | Windows Service Lifecycle 与严格 Named-pipe/State/Secret/Baileys ACL Enforcement；稳定版本。 |

该表刻意区分实现证据与精确 tag 验收。详细的无内容证据见
[Stage 8 候选发布验收](acceptance/release-candidate-stage-8.md)。
