---
title: Release status
---

# Release status

## Versions

| Documentation | Product | Source | Status |
| --- | --- | --- | --- |
| Next | `0.1.0-dev` | current `main` build commit | Unreleased and mutable |
| `0.1.0-rc.4` | `0.1.0-rc.4` | tag `v0.1.0-rc.4`, commit `bf3b583f1c877cf80ff3fb77c104653eb4df5d70` | Published prerelease; not stable |

The prerelease was published on 2026-09-02. Its
[GitHub Release](https://github.com/mwe-support/codex-channel-bridge/releases/tag/v0.1.0-rc.4)
archive SHA-256 is
`c99afaed120148b5ca06da13e62de672911d7033049cd6e5d4352154c145cf70`.
The immutable `rc.1`, `rc.2`, and `rc.3` tags were failed CI candidates and did
not publish GitHub Releases. There is no stable release and no `latest` alias.

## Acceptance boundary

| Status | Scope |
| --- | --- |
| Implemented and accepted | Native macOS Supervisor lifecycle; real QQ private-message round trip; `/help`, `/status`, `/new`, `/model`, `/reasoning`; native Codex protocol; owner-only Unix control plane; deterministic rc.4 release gates. |
| Implemented on current `main`, not included in rc.4 | Checksum-verified native install/upgrade scripts; canonical quick/full interactive setup; loopback-only Dashboard showing the running Bridge version, health, Channel connectivity, content-free events, and confirmed settings changes; `bridge --version`; local POSIX/macOS and native Windows application-level acceptance. |
| Implemented, but the exact rc.4 tag was not revalidated after the runtime refactor | Real WhatsApp private/group and restart flow; native Linux systemd lifecycle; Linux Docker non-root, health, no-published-port, and graceful-stop flow. |
| Implemented and covered below real-Channel acceptance | `/attach` native binding and Workspace validation; it was not exercised through the real QQ client in the rc.4 run. |
| Planned or unverified | Windows Service lifecycle and strict named-pipe/state/secret/Baileys ACL enforcement; stable release. |

This table deliberately separates implementation evidence from exact-tag
acceptance. Details and content-free evidence are retained in
[Stage 8 release-candidate acceptance](acceptance/release-candidate-stage-8.md)
and [Stage 9 native Windows application acceptance](acceptance/windows-stage-9.md).
