---
title: Quickstart
---

# Quickstart

The only published build is currently the `v0.1.0-rc.4` prerelease. It is
suitable for evaluation, not a stable-production claim. Read the
[release status](release-status.md) before relying on a provider or platform.

## 1. Install or upgrade

The maintained installer downloads the exact release archive and checksum,
verifies both the checksum and embedded package version, builds it in a new
version directory, and then switches the `bridge` launcher atomically. It never
installs or upgrades Codex.

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/mwe-support/codex-channel-bridge/main/install.sh | CODEX_CHANNEL_BRIDGE_VERSION=0.1.0-rc.4 sh
```

Windows PowerShell:

```powershell
$env:CODEX_CHANNEL_BRIDGE_VERSION='0.1.0-rc.4'; irm https://raw.githubusercontent.com/mwe-support/codex-channel-bridge/main/install.ps1 | iex
```

Run the same command with a newer exact version to upgrade. Existing
configuration, Profile data, and older installed versions are preserved. Once
a stable release exists, omit `CODEX_CHANNEL_BRIDGE_VERSION` to select the
latest stable release.

The POSIX defaults are `~/.local/share/codex-channel-bridge` and
`~/.local/bin/bridge`. Windows defaults to
`%LOCALAPPDATA%\CodexChannelBridge`. Override them with
`CODEX_CHANNEL_BRIDGE_INSTALL_ROOT` and `CODEX_CHANNEL_BRIDGE_BIN_DIR`.

### Manual verification

Open the [v0.1.0-rc.4 release page](https://github.com/mwe-support/codex-channel-bridge/releases/tag/v0.1.0-rc.4),
download `codex-channel-bridge-0.1.0-rc.4.tar.gz` and its checksum, then verify:

```sh
sha256 -c codex-channel-bridge-0.1.0-rc.4.tar.gz.sha256
```

The expected archive SHA-256 is
`c99afaed120148b5ca06da13e62de672911d7033049cd6e5d4352154c145cf70`.

## 2. Supply prerequisites

- Node.js 22 or newer and npm 10 or newer.
- Codex CLI `0.149.1`, installed by the host administrator.
- One absolute Workspace, Codex home, and Bridge state directory per Profile.
- QQ credentials through Secret References, or a Profile-local WhatsApp auth
  directory created by the host-local pairing flow.

The Bridge never installs or upgrades the host's Codex CLI.

## 3. Configure and validate

```sh
bridge config check --config /absolute/path/config.yaml
```

Start from `config.example.yaml`, then follow [Configuration](configuration.md)
and the [QQ](qq-adapter.md) or [WhatsApp](whatsapp-adapter.md) guide. Keep every
credential outside the repository. The current `main` build also provides
`bridge setup quick` and `bridge setup full`; they will enter the next release
and are not part of immutable `v0.1.0-rc.4`.

## 4. Run the foreground Supervisor

```sh
bridge supervisor run \
  --config /absolute/path/config.yaml \
  --endpoint /absolute/path/control.sock
```

In another terminal, query liveness and Profile readiness:

```sh
bridge status \
  --endpoint /absolute/path/control.sock
```

For a persistent installation, continue with [Platform deployment](deployment.md).
The Docker runtime exposes no administration or documentation port by default.
