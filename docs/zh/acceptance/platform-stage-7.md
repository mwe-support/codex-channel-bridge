# Stage 7 平台验收

日期：2026-09-01

## 原生 macOS

- macOS 26.6.2、Node.js 22.23.1、npm 10.9.8，以及管理员提供的 Codex CLI 0.149.1。
- 真实 Per-user launchd Job 启动了一个前台 Supervisor，并进入 `ready`。
- Owner-only Unix Control Socket 分别报告 Supervisor Liveness 与 Profile Readiness。
- `launchctl print` 显示 60 秒 Exit Timeout；验收 Configuration 使用 45 秒 Drain 与 5 秒 Child-exit Timeout。
- Runtime 被复制到受保护 Downloads Directory 之外，因为后台 LaunchAgent 不能依赖交互式 Terminal 的文件访问授权。
- 通过已登录的 QQ Desktop Client 完成真实 Inbound/Outbound QQ 交互，并返回固定 Stage 7 Marker。
- Bootout 产生 `ready -> draining -> stopped`，Supervisor 成功退出。

## 原生 Linux

- `marvel-mini-pc` 上的 Ubuntu 24.04、Kernel 6.8.0-106-generic、Node.js 22.22.1、npm 10.9.4，以及管理员提供的 Codex CLI 0.149.1。
- 全新 Dependency Installation、217 项 Unit Test、2 项 Platform-definition Test、4 项 Control-plane Contract、Supervisor Process Contract 与 Codex Protocol Contract 通过。
- 真实 User-systemd Unit 进入 `ready`，暴露本地 Control Socket，并以 `ready -> draining -> stopped`、Exit Status 0 停止。

## Linux Docker

- `marvel-mini-pc` 上的 Docker 29.3.0 Build 了 Production Multi-stage Image。
- Runtime 使用 Non-root `node` Identity、不发布 Port，并通过 Container-local Unix Socket 报告 Healthy。
- 隔离 Profile 使用 Image 内固定的 Codex CLI 0.149.1 与全新空 Codex Home 进入 `ready`。
- Docker `SIGTERM` 产生 `ready -> draining -> stopped`，Container Exit Status 为 0。

本证据不保留 Raw Provider Identity、Credential、Message Body、Codex Input/Output 或本地 Sensitive Path。在指定真实 Windows Host 前，原生 Windows 仍未验证。
