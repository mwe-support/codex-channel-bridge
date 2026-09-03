---
title: 快速开始
---

# 快速开始

目前唯一已发布构建是候选版本 `v0.1.0-rc.4`，可用于评估，但不代表稳定生产
承诺。在依赖某个 Provider 或平台前，请先阅读[发布状态](release-status.md)。

## 1. 安装或升级

官方维护的安装器会下载准确版本的发布包和校验文件，验证 SHA-256 与包内版本，
在新版本目录完成构建后再原子切换 `bridge` 启动器。安装器绝不会安装或升级
Codex。

macOS 或 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/mwe-support/codex-channel-bridge/main/install.sh | CODEX_CHANNEL_BRIDGE_VERSION=0.1.0-rc.4 sh
```

Windows PowerShell：

```powershell
$env:CODEX_CHANNEL_BRIDGE_VERSION='0.1.0-rc.4'; irm https://raw.githubusercontent.com/mwe-support/codex-channel-bridge/main/install.ps1 | iex
```

把准确版本号换成新版本后再次执行同一条命令即可升级。已有配置、Profile 数据和
旧版本目录都会保留。首个稳定版发布后，可以省略
`CODEX_CHANNEL_BRIDGE_VERSION`，由安装器选择最新稳定版。

打开新 Terminal，验证当前选中的安装版本：

```sh
bridge --version
```

POSIX 默认安装到 `~/.local/share/codex-channel-bridge`，命令位于
`~/.local/bin/bridge`；Windows 默认安装到
`%LOCALAPPDATA%\CodexChannelBridge`。可通过
`CODEX_CHANNEL_BRIDGE_INSTALL_ROOT` 与 `CODEX_CHANNEL_BRIDGE_BIN_DIR` 覆盖。

### 手动校验

打开 [v0.1.0-rc.4 Release 页面](https://github.com/mwe-support/codex-channel-bridge/releases/tag/v0.1.0-rc.4)，
下载 `codex-channel-bridge-0.1.0-rc.4.tar.gz` 及其校验文件，然后执行：

```sh
sha256 -c codex-channel-bridge-0.1.0-rc.4.tar.gz.sha256
```

预期归档 SHA-256 为
`c99afaed120148b5ca06da13e62de672911d7033049cd6e5d4352154c145cf70`。

## 2. 准备前置条件

- Node.js 22 或更高版本，以及 npm 10 或更高版本。
- 由主机管理员安装的 Codex CLI `0.149.1`。
- 每个 Profile 各自独占的绝对 Workspace、Codex Home 和 Bridge State 目录。
- 通过 Secret Reference 提供 QQ 凭据，或通过本地主机配对流程创建 Profile 本地
  WhatsApp Auth 目录。

Bridge 绝不会安装或升级主机上的 Codex CLI。

## 3. 配置并校验

```sh
bridge config check --config /absolute/path/config.yaml
```

以 `config.example.yaml` 为起点，再阅读[配置](configuration.md)以及
[QQ](qq-adapter.md) 或 [WhatsApp](whatsapp-adapter.md) 指南。任何凭据都不得进入仓库。
当前 `main` 构建也提供 `bridge setup quick` 与 `bridge setup full`；它们会进入
下一个版本，不属于不可变的 `v0.1.0-rc.4`。

## 4. 以前台方式运行 Supervisor

```sh
bridge supervisor run \
  --config /absolute/path/config.yaml \
  --endpoint /absolute/path/control.sock
```

在另一个终端查询 Liveness 和 Profile Readiness：

```sh
bridge status \
  --endpoint /absolute/path/control.sock
```

持久安装请继续阅读[平台部署](deployment.md)。Docker Runtime 默认不暴露管理端口
或文档端口。
