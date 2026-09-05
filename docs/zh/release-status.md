---
title: 发布状态
---

# 发布状态

## 版本

| 文档 | 产品 | 来源 | 状态 |
| --- | --- | --- | --- |
| `0.2.0-rc.1` | `0.2.0-rc.1` | tag `v0.2.0-rc.1` | 当前候选版本，不是稳定版 |
| `0.1.0-rc.4` | `0.1.0-rc.4` | tag `v0.1.0-rc.4`，commit `bf3b583f1c877cf80ff3fb77c104653eb4df5d70` | 已发布候选版本，不是稳定版本 |

`0.2.0-rc.1` 于 2026-09-05 整理，并发布在对应的
[GitHub Release](https://github.com/mwe-support/codex-channel-bridge/releases/tag/v0.2.0-rc.1)。
上一候选版本于 2026-09-02 发布。[GitHub Release](https://github.com/mwe-support/codex-channel-bridge/releases/tag/v0.1.0-rc.4)
归档 SHA-256 为
`c99afaed120148b5ca06da13e62de672911d7033049cd6e5d4352154c145cf70`。
不可变的 `rc.1`、`rc.2` 和 `rc.3` tag 是 CI 失败候选，没有发布 GitHub Release。
当前不存在稳定版本，也没有 `latest` 别名。

## 验收边界

| 状态 | 范围 |
| --- | --- |
| 已在原生 macOS 实现并验收 | Supervisor 生命周期；真实 QQ、WhatsApp 私聊/群聊；QQ 私聊原生回复流；无参数模型/思考强度查询；原生审批往返；自动输出文件下载且摘要匹配；原生 Codex 协议；Owner-only Unix Control Plane。 |
| 已在应用/平台边界实现并验收 | 校验 Checksum 的安装/升级脚本；快速/完全设置；仅绑定 Loopback 的 Dashboard；`bridge --version`；原生 Windows 构建、严格 Control-pipe ACL 与一次性 Service Lifecycle；原生 Linux systemd；Linux Docker 非 root、Health 与优雅停止。 |
| 已纳入但有明确候选版限制 | WhatsApp 输入中提示可见性/清理、独立 Turn 中断、QQ 回复流剩余过期/限流/重启/并发场景，以及 Linux、Linux Docker、Windows 输出文件投递。确定性契约通过，但对应真实验收仍待完成。 |
| 已规划或未验证 | Dashboard YAML 编辑、Profile 实时日志、重启控制、会话管理、随 Release 提供的数据 ACL 验收，以及稳定版本。 |

该表刻意区分实现证据与精确 tag 验收。详细的无内容证据见
[Stage 8 候选发布验收](acceptance/release-candidate-stage-8.md)、
[Stage 9 原生 Windows 应用层验收](acceptance/windows-stage-9.md)以及
`docs/zh/acceptance/` 下的功能专项记录。
