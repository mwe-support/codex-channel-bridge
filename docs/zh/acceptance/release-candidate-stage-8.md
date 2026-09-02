# 阶段 8 候选发布版验收

- 日期：2026-09-01
- 候选基线：`8686040`（`fix: complete WhatsApp live acceptance`）
- 候选发布版：`v0.1.0-rc.4`；后续 Runtime 重构 `d604739` 已通过真实 macOS
  QQ 复验，之后只有 Release Workflow 与文档变更
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
- 架构精简后，真实 QQ-to-Codex 往返于 2026-09-01 返回准确的
  `PONYTAIL-QQ-READY` 标记。这对 `d604739` 的可运行 macOS QQ 路径完成
  复验，仓库中未保留消息正文或 Raw Provider Identifier。

## 原生 macOS 与真实 WhatsApp

- Owner-only Host-local Pairing 激活真实 Baileys Auth Generation，Adapter
  达到 `ready`；验收 Evidence 未保留 Pairing Material。
- 真实私聊消息完成一次 Codex Turn 与 Provider `accepted` 的 Outbox
  Delivery；原生客户端可见回复已到达，Graceful Restart 无需再次扫码即可
  打开 Active Authentication。
- 真实本地 `/status` 命令完成回复且不创建 Codex Input。测试群内未选择成员的
  `@` 文本保持 Passive；从成员候选中选择真实 Momo 后，Archive、Codex
  Correlation、Logical Result、Accepted Outbox 与客户端可见群回复均完成。
- 本次验收修复首次配对 Parent Creation、Baileys 7 Activation Criteria，以及
  账号 Phone-number JID 与 LID 间的群提及匹配。临时群聊 Access 已在测试后恢复
  为 `deny`。

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

## v0.1.0 候选版确定性发布门禁

- 2026-09-02，`release:check --tag=v0.1.0-rc.4` 在本机通过；全部 Workspace、
  Lockfile、文档、Changelog 与 Runtime Version Mirror 保持一致。
- 本地测试通过 219 项 Unit Test、2 项 Release-tool Test 与 2 项 Platform
  Contract Test。
- 宿主 macOS Codex Protocol Contract 使用 Codex CLI `0.149.1` 通过，Schema
  SHA-256 为
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`。
- 4 项 Owner-only Unix Control-plane Contract 与 Supervisor Worker Process
  Contract 均在宿主 macOS 环境通过。沙箱内的 `EPERM`/stdout closed 只作为
  环境限制，不作为宿主验收结果。
- 不可变 `v0.1.0-rc.1` Tag 因测试 Helper 只允许 20 个 Event-loop Turn，暴露
  两项仅 CI 可见的 Supervisor Restart-test Timeout，且没有发布 GitHub
  Release。`v0.1.0-rc.2` 只把该共用等待改成 2 秒实际时间上限；Targeted Suite
  单次通过，并在本机 32 路进程并发下重复 128 次全部通过。
- 不可变 `v0.1.0-rc.2` Tag 已在 GitHub 通过确定性测试套件，但 Host-only
  Supervisor Process Contract 尝试启动健康 Profile 时，通用 Runner 正确报告
  `codex_not_found`，因此没有发布 GitHub Release。`v0.1.0-rc.3` 保留文档要求
  的宿主门禁，只删除无效的通用 Runner 调用。
- 不可变 `v0.1.0-rc.3` Tag 已通过 GitHub Verify Job，但 Release Checkout 在
  Tag 类型断言前使用事件的 Peeled Commit 替换了本地附注 Tag Ref，因此没有
  发布 GitHub Release。`v0.1.0-rc.4` 显式 Checkout 已推送的 Tag Ref，且不
  改变 Runtime 行为。

## 剩余发布边界

- 尚未指定原生 Windows Host；Windows Service 与 Named-pipe ACL 验收仍未
  完成。
- `/attach` 已覆盖 Native-runtime 与 Binding Test，但本次未通过真实 QQ
  客户端执行。
- 上述真实 WhatsApp、原生 Linux 与 Linux Docker 验收使用 Stage 8
  Baseline；本记录不声称已经完成针对 `v0.1.0-rc.4` 准确代码树的重构后
  复验，该工作属于候选发布版后续验收。

本 Evidence 不保留 Credential、Secret Reference、Raw Provider Identity、
Provider Message ID、Channel Body、Codex Output、Reasoning 或敏感本地路径。
