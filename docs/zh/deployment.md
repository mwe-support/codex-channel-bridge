# 平台部署

首版每个 Deployment 只运行一个前台 Bridge Supervisor。平台 Service Manager 只
负责这个 Process；Supervisor 负责其 Profile Worker，每个 Worker 再负责一个
Profile-local Codex App Server Child。Bridge 绝不在原生 Host 安装或升级 Codex
CLI。

静态 Service Definition 位于 `packages/platform`。它们使用常规 Production
Path，只有在替换目标 Host 的 Path 与 Service Identity 后才能安装。Configuration、
State Root、Codex Home、Workspace 与 Secret File 必须保存在仓库外。

## 通用安装门槛

注册 Service 前：

1. 选择不可变的 `vVERSION` GitHub Release，下载
   `codex-channel-bridge-VERSION.tar.gz` 及其 `.sha256` 文件，验证校验和，并且
   只使用该源码包内的文档。生产部署不能使用持续变化的 `main` checkout。
2. 由 Service Identity 安装 Node.js 22 或更高版本，以及 Codex CLI `0.149.1`。
   在 Service Definition 中写入已验证的 Node 绝对 Path，并在每个 Profile
   Configuration 中写入已验证的 `codexExecutable` 绝对 Path；Service-manager
   `PATH` Lookup 不能用作 Version Selection Mechanism。
3. 把已验证的 release 解压到 `/opt/codex-channel-bridge`，执行 `npm ci` 和
   `npm run build`。普通 Service Start 绝不运行 npm。
4. 创建 `/etc/codex-channel-bridge/config.yaml` 和所有已配置的 Profile
   Directory。State 与 Secret Directory 必须通过 [`configuration.md`](configuration.md)
   中的 Owner-only Check。
5. 启用 Service 前执行 `bridge config check`、`npm run test:contract` 和
   `npm run test:platform-contract`。

## 原生 macOS

把 `packages/platform/macos/org.codex-channel-bridge.supervisor.plist` 用作一个
LaunchDaemon 或 Per-user LaunchAgent。如果 Deployment 使用其他固定位置，请替换
`/opt` 与 `/etc` Path，并把 `/usr/local/bin/node` 替换为已验证的 Node 22
Executable。以 Service Identity 创建
`/var/tmp/codex-channel-bridge`，Mode 为 `0700`；Bridge 创建 Mode `0600` 的
Control Socket。

Job 保持前台运行，`launchd` 只重启非成功退出。已验收的 macOS 26 Per-user Job
显示 60 秒 launchd Exit Timeout，因此其 Configuration 必须把 `drainTimeoutMs`
设为不超过 45,000，把 `childExitTimeoutMs` 设为不超过 5,000。使用
`launchctl print` 查看 Service State，使用 `bridge status` 查看 Supervisor
Liveness；Profile Readiness 仍是独立管理检查。

## 原生 Linux

把 `packages/platform/linux/codex-channel-bridge.service` 安装为一个 systemd
Unit。常规 Service Identity 是 `codex-bridge`；只有 Host 使用另一个专用 Identity
时才调整 Unit。`RuntimeDirectory` 创建 Owner-only Control Directory。
`KillMode=mixed` 先向 Supervisor 发送 Graceful Stop Signal，只在 Service Timeout
后对 Process Group 使用 `SIGKILL`，避免 Profile Child 尚未 Drain 就被终止。

```sh
systemctl enable --now codex-channel-bridge.service
systemctl status codex-channel-bridge.service
sudo -u codex-bridge node /opt/codex-channel-bridge/packages/cli/dist/main.js status \
  --endpoint /run/codex-channel-bridge/control.sock
```

## Linux Docker

从仓库根目录 Build Production Multi-stage Image：

```sh
BRIDGE_VERSION="$(cat docs/VERSION)"
docker build -f packages/platform/docker/Dockerfile \
  -t "codex-channel-bridge:$BRIDGE_VERSION" .
```

Build Stage 使用完整 Bookworm Image 提供 `better-sqlite3` 所需 Native Compiler
Toolchain。Runtime 使用 Bookworm Slim，以已有的非 Root `node` Identity 运行，并在
Image Build 时固定 Codex CLI `0.149.1`。运行中的 Container 不执行 Package
Installation 或 Self-update。

Configuration 以 Read-only 方式 Mount；每个已配置 Profile State Directory、
Codex Home 与 Workspace 使用可写、Owner-only Volume。Docker Operator 在同一
Container 内运行 Bridge CLI；不发布 Administration Port。

```sh
BRIDGE_VERSION="$(cat docs/VERSION)"
docker run --name codex-channel-bridge \
  --init \
  --stop-timeout 320 \
  -v /host/config.yaml:/etc/codex-channel-bridge/config.yaml:ro \
  -v /host/profiles:/var/lib/codex-channel-bridge/profiles \
  "codex-channel-bridge:$BRIDGE_VERSION"
```

Image 声明 `SIGTERM` 为 Stop Signal，并通过 Container-local Unix Socket 执行
`bridge status` 作为只覆盖 Liveness 的 Health Check。它不发布 TCP 或 HTTP
Port。单个 Unavailable Profile 不会使 Container Unhealthy。

## Windows 边界

原生 Windows 仍是首版目标，但在指定真实 Windows Host 前，不验收 Service
Package。Runtime Named-pipe Shape 不是严格 Windows ACL Behavior 的证据。不得用
macOS、Linux、Wine 或 Container Test 宣称 Windows Service Support。
