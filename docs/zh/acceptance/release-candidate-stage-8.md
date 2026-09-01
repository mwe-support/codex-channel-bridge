# 阶段 8 候选发布版验收

- 日期：2026-09-01
- 候选版本：基于 `2cffd29` 的阶段 8 工作树
- 受测 Codex CLI：`0.149.1`

## 原生 macOS 与真实 QQ

- Per-user launchd 部署达到 Supervisor `live` 与 Profile `ready`，稳定
  Schema 验证通过，并探测到可选的 `thread/settings/update` Capability。
- 已登录的原生 QQ 客户端发送一条真实私聊消息；Bridge 完成 Codex Turn，
  客户端显示准确的 `STAGE8-COMMANDS-READY` 标记。
- `/status` 与 `/help` 显示 Bridge-owned Reply。首次真实 `/status` 暴露 QQ
  被动回复缺少 Sequence；共享 Command Reply 出口现固定使用该入站消息的
 首个回复序号，重复命令显示 `Profile ready; active=0; queued=0.`。
- `/model` 从原生 `model/list` 发现的条目中选择 Model；`/reasoning` 从该
  Model 的原生 Supported Effort 中选择强度。两者都通过
  `thread/settings/update` 成功，Bridge 不持久化竞争性的 Model 或 Effort
  Selection。
- `/new` 解除当前 Bridge-owned Binding。下一条消息最初暴露 Detached Row
  的 Unique-key Conflict；现改为原位重绑定并保留 Binding ID，以满足既有
  Correlation Foreign Key。重复真实消息创建新的原生 Thread，并显示准确的
  `STAGE8-NEW-THREAD-READY` 标记。
- launchd Stop 完成统一的有界 Drain，并成功退出。

## 原生 Linux

- 目标：`marvel-mini-pc`；Node.js 22.22.1、npm 10.9.4，以及 Administrator
  提供的 Codex CLI 0.149.1。
- Fresh Dependency Installation、219 项 Unit Test、2 项 Platform Test、
  Codex Protocol Contract、4 项 Owner-only Control-plane Contract 与
  Supervisor Process Contract 全部通过。
- Transient user-systemd Service 达到 Supervisor `live` 与 Profile
  `ready`。停止结果为 `Result=success`、`ExecMainStatus=0`，最终状态为
  inactive/dead。

## Linux Docker

- Production Multi-stage Image 使用固定 Codex CLI 0.149.1 构建成功。
- Container 以 `node` 运行，不发布 Port，Health 为 `healthy`，Supervisor
  达到 `live`，Profile 达到 `ready`。
- Docker SIGTERM 后退出码为 0，且未发生 OOM。

## 剩余发布边界

- 本次未配对真实 WhatsApp Account；Baileys Provider 验收仍只覆盖确定性的
  Adapter、Authentication、Lifecycle、Media 与 Delivery Test。
- 尚未指定原生 Windows Host；Windows Service 与 Named-pipe ACL 验收仍未
  完成。
- `/attach` 已覆盖 Native-runtime 与 Binding Test，但本次未通过真实 QQ
  客户端执行。

本 Evidence 不保留 Credential、Secret Reference、Raw Provider Identity、
Provider Message ID、Channel Body、Codex Output、Reasoning 或敏感本地路径。
