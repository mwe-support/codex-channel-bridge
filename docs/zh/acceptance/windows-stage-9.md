# Stage 9 原生 Windows 应用层验收

- 日期：2026-09-03
- 已验收 Commit：`68b2468`（`fix: support native Windows runtime`）
- Host：Windows `10.0.26200`、Node.js `24.13.0`、npm `11.6.2`
- 管理员提供的 Codex CLI：显式 Executable `0.153.0-alpha.5`

## 已验收范围

- 已发布的 `v0.1.0-rc.4` PowerShell Installer 完成真实临时安装，验证 Release
  Checksum 与包内版本，构建 CLI、切换 Current-version Marker，并恢复测试 PATH。
  Codex Executable Path、Version 与 SHA-256 均未变化。
- 快速与完全交互式 Setup 均成功写入 Configuration，并通过
  `bridge config check`。Windows Directory Handle 不再传给 `fsync`，File
  Durability 保持不变。
- `npm test` 得到 224 项通过、0 项失败、5 项明确跳过；跳过项仅覆盖 POSIX
  Permission、Symlink 与 Installer Contract。Release Check 与中英文文档构建均
  通过。
- 原生 Named-pipe Request 返回 Supervisor Status；Loopback Dashboard 的 Status
  API 正常并显示 `0.1.0-dev`；`bridge --version` 返回 `0.1.0-dev`。
- App Server Process Fixture、生成文档 Path、Profile Storage、Baileys Auth
  Persistence、Configuration、Support Output 与 Maintenance-hold Test 已使用
  Windows 原生 Filesystem Behavior 与 Path Separator。
- Local Control Server 停止时会关闭仍存在的 Idle Connection，已连接 Client 不再
  能无限期阻止 Process 退出。
- 一次性提权验收脚本在核验 SHA-256
  `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`
  后安装 WinSW `2.12.0` x64。临时 Manual Service 以
  `NT AUTHORITY\LocalService` 运行前台 Supervisor；SCM 报告 `Running`，原生
  Named Pipe `status/get` 请求成功，有界停止后 SCM 报告 `Stopped`，卸载后
  Service 与隔离的临时文件均已移除。管理员提供的 Codex Executable Path、
  Version 与 Hash 均未改变。

## 未验收边界

- Named Pipe、Profile State、Secret 与 Baileys Authentication 的严格 ACL 创建
  与验证尚未实现；POSIX Mode Check 不会被当作 Windows ACL 证据。
- 此一次性验收 Service 不是随 Release 提供的 Service Installer。Production
  Windows Service Support 仍受上述严格 ACL 边界阻断；本轮也未故障注入验证
  Service Failure Recovery。
- Host 存在多个 Codex 安装：显式 Executable Probe 为 `0.153.0-alpha.5`，而 Node
  Child 使用裸 `codex.exe` 时会解析到另一个版本。Windows Profile 与未来 Service
  Definition 必须使用经过验证的 `codexExecutable` 绝对 Path。
- 本阶段未在 Windows 执行真实 QQ 或 WhatsApp 往返。

本证据不保留 Credential、Secret Reference、Raw Provider Identity、Channel
Body、Codex Input/Output、Reasoning 或 Sensitive Local Path。
