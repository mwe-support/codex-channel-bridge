# Platform deployment

The first release runs exactly one foreground Bridge Supervisor per deployment.
The platform service manager owns only that process; the Supervisor owns its
Profile workers, and each worker owns one Profile-local Codex App Server child.
The Bridge never installs or upgrades a native host's Codex CLI.

Static service definitions live in `packages/platform`. They use conventional
production paths and are examples to install only after replacing paths and the
service identity for the target host. Keep the configuration, state roots,
Codex homes, Workspaces, and Secret files outside the repository.

## Common installation gate

Before registering a service:

1. Select an immutable `vVERSION` GitHub Release. Download
   `codex-channel-bridge-VERSION.tar.gz` and its `.sha256` file, verify the
   checksum, and use only the documentation inside that archive. Do not deploy
   a moving `main` checkout as a production version.
2. Provide Node.js 22 or newer and an administrator-installed Codex CLI with the required App Server capabilities to the service identity.
   Put the verified absolute Node path in the service definition and the
   verified absolute `codexExecutable` path in every Profile configuration;
   service-manager `PATH` lookup is not a version-selection mechanism.
3. Extract the verified release to `/opt/codex-channel-bridge`, run `npm ci`, then
   `npm run build`. A normal service start never runs npm.
4. Create `/etc/codex-channel-bridge/config.yaml` and every configured Profile
   directory. State and Secret directories must satisfy the owner-only checks
   in [`configuration.md`](configuration.md).
5. Run `bridge config check`, `npm run test:contract`, and
   `npm run test:platform-contract` before enabling the service.

## Native macOS

Use `packages/platform/macos/org.codex-channel-bridge.supervisor.plist` as one
LaunchDaemon or per-user LaunchAgent. Replace `/opt` and `/etc` paths when the
deployment uses another fixed location, and replace `/usr/local/bin/node` with
the verified Node 22 executable. Create `/var/tmp/codex-channel-bridge`
as the service identity with mode `0700`; the Bridge creates the control socket
as `0600`.

The job stays in the foreground and `launchd` restarts only an unsuccessful
exit. The accepted macOS 26 per-user job exposes a 60-second launchd exit
timeout, so its configuration must keep `drainTimeoutMs` at or below 45,000 and
`childExitTimeoutMs` at or below 5,000. Use `launchctl print` for service state
and `bridge status` for Supervisor liveness; Profile readiness remains a
separate administration check.

## Native Linux

Install `packages/platform/linux/codex-channel-bridge.service` as one systemd
unit. Its conventional service identity is `codex-bridge`; adjust the unit only
when the host uses another dedicated identity. `RuntimeDirectory` creates the
owner-only control directory. `KillMode=mixed` sends the graceful stop signal
to the Supervisor first and reserves process-group `SIGKILL` for the service
timeout, rather than terminating Profile children before their drain.

```sh
systemctl enable --now codex-channel-bridge.service
systemctl status codex-channel-bridge.service
sudo -u codex-bridge node /opt/codex-channel-bridge/packages/cli/dist/main.js status \
  --endpoint /run/codex-channel-bridge/control.sock
```

## Linux Docker

Build the production multi-stage image from the repository root:

```sh
BRIDGE_VERSION="$(cat docs/VERSION)"
docker build -f packages/platform/docker/Dockerfile \
  --build-arg CODEX_VERSION="${CODEX_VERSION:?Set an explicit Codex package version}" \
  -t "codex-channel-bridge:$BRIDGE_VERSION" .
```

The build stage includes the native compiler toolchain from the full Bookworm
image for `better-sqlite3`. The runtime uses Bookworm Slim, runs as the existing
non-root `node` identity. Supply an explicit Codex package version in
`CODEX_VERSION` for reproducible builds; this is not a Bridge compatibility
allowlist. Runtime capability probes decide availability. The running container
performs no package installation or self-update.

Mount the configuration read-only and give the container writable, owner-only
volumes for every configured Profile state directory, Codex home, and
Workspace. Docker operators run the Bridge CLI inside the same container; no
administration port is published.

```sh
BRIDGE_VERSION="$(cat docs/VERSION)"
docker run --name codex-channel-bridge \
  --init \
  --stop-timeout 320 \
  -v /host/config.yaml:/etc/codex-channel-bridge/config.yaml:ro \
  -v /host/profiles:/var/lib/codex-channel-bridge/profiles \
  "codex-channel-bridge:$BRIDGE_VERSION"
```

The image declares `SIGTERM` as its stop signal and uses `bridge status` over
the container-local Unix socket as its liveness-only health check. It does not
publish TCP or HTTP ports. One unavailable Profile does not make the container
unhealthy.

## Windows boundary

The designated Windows acceptance host has passed the one-command installer,
quick/full setup, native build, named-pipe request flow, Dashboard, version
reporting, and the cross-platform test suite. Keep every Profile's
`codexExecutable` absolute; PATH lookup selected a different installed Codex on
the acceptance host.

A one-time elevated WinSW `2.12.0` acceptance service passed install, start,
named-pipe status, bounded stop, uninstall, cleanup, and Codex-integrity checks
on the designated host. This proves the foreground Supervisor lifecycle under
SCM, but it is not a release-packaged service installer. The bundled
PowerShell/C# helper now owns the control pipe and verifies a protected DACL
limited to the service identity, LocalSystem, and BUILTIN\Administrators.
Strict ACL checks for Profile state, secrets, and Baileys auth remain
first-release blockers. Do not claim native Windows production service support
until those boundaries pass on the designated host.
