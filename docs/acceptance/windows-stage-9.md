# Stage 9 native Windows application acceptance

- Date: 2026-09-03
- Accepted commit: `68b2468` (`fix: support native Windows runtime`)
- Host: Windows `10.0.26200`, Node.js `24.13.0`, npm `11.6.2`
- Administrator-supplied Codex CLI: explicit executable `0.153.0-alpha.5`

## Accepted scope

- The published `v0.1.0-rc.4` PowerShell installer completed a real temporary
  installation, verified the release checksum and embedded package version,
  built the CLI, switched the current-version marker, and restored the test
  PATH. The Codex executable path, version, and SHA-256 were unchanged.
- Quick and full interactive setup both wrote configurations that passed
  `bridge config check`. Windows directory handles are no longer passed to
  `fsync`; file durability remains intact.
- `npm test` completed with 224 passes, zero failures, and five explicit skips
  for POSIX-only permission, symlink, and installer contracts. Release checks
  and both English and Chinese documentation builds passed.
- A native named-pipe request returned Supervisor status, the loopback
  Dashboard returned its status API and displayed `0.1.0-dev`, and
  `bridge --version` returned `0.1.0-dev`.
- App Server process fixtures, generated documentation paths, Profile storage,
  Baileys auth persistence, configuration, support output, and maintenance-hold
  tests now use Windows-native filesystem behavior and path separators.
- Stopping the local control server now closes outstanding idle connections, so
  an attached client cannot indefinitely retain the process.
- A one-time elevated acceptance script installed WinSW `2.12.0` x64 after
  verifying SHA-256
  `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`.
  The temporary manual service ran the foreground Supervisor as
  `NT AUTHORITY\LocalService`; SCM reported `Running`, a native named-pipe
  `status/get` request succeeded, SCM reported `Stopped` after the bounded stop,
  and uninstall removed the service and its isolated temporary files. The
  administrator-supplied Codex executable path, version, and hash were unchanged.

## Unaccepted boundaries

- Strict ACL creation and verification for the named pipe, Profile state,
  secrets, and Baileys authentication are not implemented. POSIX mode checks
  are intentionally not treated as Windows ACL evidence.
- The one-time acceptance service is not a release-packaged service installer.
  Production Windows service support remains blocked on the strict ACL boundary
  above; service failure recovery was not fault-injected in this run.
- The host had multiple Codex installations: the explicit executable probed as
  `0.153.0-alpha.5`, while a Node child using bare `codex.exe` resolved another
  version. Windows Profiles and future service definitions must use a verified
  absolute `codexExecutable` path.
- No real QQ or WhatsApp round trip was performed on Windows in this stage.

No credential, Secret Reference, raw provider identity, Channel body, Codex
input/output, reasoning, or sensitive local path is retained in this evidence.
