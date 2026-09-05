---
title: Release status
---

# Release status

## Versions

| Documentation | Product | Source | Status |
| --- | --- | --- | --- |
| `0.2.0-rc.1` | `0.2.0-rc.1` | tag `v0.2.0-rc.1` | Current prerelease; not stable |
| `0.1.0-rc.4` | `0.1.0-rc.4` | tag `v0.1.0-rc.4`, commit `bf3b583f1c877cf80ff3fb77c104653eb4df5d70` | Published prerelease; not stable |

`0.2.0-rc.1` was prepared on 2026-09-05 and is published at its
[GitHub Release](https://github.com/mwe-support/codex-channel-bridge/releases/tag/v0.2.0-rc.1).
The previous prerelease was published on 2026-09-02. Its
[GitHub Release](https://github.com/mwe-support/codex-channel-bridge/releases/tag/v0.1.0-rc.4)
archive SHA-256 is
`c99afaed120148b5ca06da13e62de672911d7033049cd6e5d4352154c145cf70`.
The immutable `rc.1`, `rc.2`, and `rc.3` tags were failed CI candidates and did
not publish GitHub Releases. There is no stable release and no `latest` alias.

## Acceptance boundary

| Status | Scope |
| --- | --- |
| Implemented and accepted on native macOS | Supervisor lifecycle; real QQ and WhatsApp private/group interaction; native QQ private answer streaming; bare model/reasoning queries; native approval round trips; automatic output-file downloads with matching digests; native Codex protocol; owner-only Unix control plane. |
| Implemented and accepted at the application/platform boundary | Checksum-verified install/upgrade scripts; quick/full setup; loopback-only Dashboard; `bridge --version`; native Windows build, strict control-pipe ACL and one-time Service lifecycle; native Linux systemd lifecycle; Linux Docker non-root, health and graceful-stop flow. |
| Included with explicit prerelease limits | WhatsApp typing visibility/cleanup, independent-Turn interruption, remaining QQ stream expiry/rate-limit/restart/concurrency cases, and output-file delivery on Linux, Linux Docker and Windows. Deterministic contracts pass, but the named live acceptance remains open. |
| Planned or unverified | Editable Dashboard YAML, Profile runtime logs, restart controls, conversation management, release-packaged data ACL acceptance, and stable release. |

This table deliberately separates implementation evidence from exact-tag
acceptance. Details and content-free evidence are retained in
[Stage 8 release-candidate acceptance](acceptance/release-candidate-stage-8.md),
[Stage 9 native Windows application acceptance](acceptance/windows-stage-9.md),
and the feature-specific records under `docs/acceptance/`.
