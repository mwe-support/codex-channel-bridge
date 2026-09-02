# Changelog

This file records user-visible changes to Codex Channel Bridge. Releases follow
[Semantic Versioning](https://semver.org/) and the release procedure in
[`docs/release.md`](docs/release.md).

## [Unreleased]

## [0.1.0-rc.4] - 2026-09-02

### Fixed

- Checked out the explicit Git tag ref in the release job so
  `actions/checkout` preserves the annotated tag object instead of replacing
  the local ref with the event's peeled commit before verification.

### Included

- Includes all Bridge capabilities and release-candidate boundaries documented
  under `0.1.0-rc.1` and the CI corrections from `0.1.0-rc.2` and
  `0.1.0-rc.3`. All earlier immutable tags are retained as failed CI
  candidates and did not produce GitHub Releases.

## [0.1.0-rc.3] - 2026-09-02

### Fixed

- Kept the real Supervisor process contract in the host release gates while
  removing it from generic GitHub runners, which do not have the required
  administrator-supplied Codex CLI and must not install one.

### Included

- Includes all Bridge capabilities and release-candidate boundaries documented
  under `0.1.0-rc.1` and the bounded test wait from `0.1.0-rc.2`. Both earlier
  immutable tags are retained as failed CI candidates and did not produce
  GitHub Releases.

## [0.1.0-rc.2] - 2026-09-02

### Fixed

- Made the Supervisor restart tests wait against a bounded elapsed-time budget
  instead of a fixed number of event-loop turns. This removes CI-only failures
  when asynchronous filesystem work completes after a few milliseconds; it
  does not change production restart behavior.

### Included

- Includes all Bridge capabilities and release-candidate boundaries documented
  under `0.1.0-rc.1`. The immutable `v0.1.0-rc.1` tag is retained as the failed
  CI candidate and did not produce a GitHub Release.

## [0.1.0-rc.1] - 2026-09-02

### Added

- A standalone multi-Profile Supervisor whose Profile workers own independent
  Codex App Server children, WAL-mode SQLite state, QQ adapters, and WhatsApp
  adapters.
- Durable inbound deduplication, Access Policy and admission control, native
  Thread start and steer, Thread Bindings, Logical Results, transactional
  Outbox delivery, provider receipts, and restart reconciliation.
- Host-local administration for configuration, migration, Profile lifecycle,
  WhatsApp pairing and revocation, diagnostics, backup coordination, Audit
  Records, Support Bundles, Archive retrieval and purge, and circuit recovery.
- Native launchd and systemd service packaging plus a non-root Linux Docker
  image, with Stage 8 acceptance on macOS, Linux, and Linux Docker.
- Native model and reasoning selection, Channel Thread commands, correlated
  Codex Approval Request transport, and real QQ and WhatsApp private/group
  interaction acceptance on the Stage 8 runtime baseline.
- A repository-wide release version gate, annotated Git tag workflow, immutable
  GitHub Release archive, checksum, and version-matched documentation policy.
- Fixed-commit documentation-stack research comparing Hermes Agent and
  OpenClaw, maintained in English and Chinese.

### Changed

- Simplified the Bridge implementation by removing speculative wrappers and
  consolidating shared configuration, storage, control-plane, and worker paths.

### Release-candidate boundaries

- This is a prerelease for acceptance of the exact tagged tree, not a stable
  production release.
- Native Windows service and named-pipe ACL acceptance remain unverified.
- `/attach` has contract coverage but has not been exercised through the real
  QQ client.
- Real WhatsApp, native Linux, and Linux Docker passed on the Stage 8 baseline;
  their post-refactor revalidation against this exact tag remains pending.
- The release contains version-matched Markdown documentation but does not yet
  publish the planned versioned Docusaurus site.
