---
title: Limits and roadmap
---

# Limits and roadmap

## First-release limits

- Shared-OS-user Profiles provide application-layer isolation, not hostile
  process isolation. Use separate OS users or containers for stronger isolation.
- Administration is authoritative through host-local structured IPC. The
  Dashboard is only a loopback adapter over it; remote App Server
  attachment and remote administration remain unsupported.
- Delivery is effectively-once. An ambiguous provider send can leave a small
  duplicate window because QQ and WhatsApp do not offer a universal idempotent
  send contract.
- Local Hybrid Retrieval uses SQLite FTS5, exact, substring, fuzzy, structured,
  and recency signals. It does not require embeddings or an external search
  service.
- Restore supports compatible paths and the same operating-system family; it
  does not rewrite Codex history to manufacture portability.
- The release mechanism publishes a source archive and checksum, not npm
  packages or a registry-hosted container image.

## Included in `0.2.0-rc.1`

- Maintained one-command native installers and atomic Bridge upgrades that
  verify immutable release checksums and never install or upgrade Codex.
- `bridge setup quick` and `bridge setup full`, both producing the canonical
  configuration accepted by the existing validation and apply flow.
- A loopback-only Dashboard showing the running Bridge version, health, Channel
  connectivity, bounded content-free events, and confirmed configuration
  plan/apply operations through the existing control plane.
- Native Windows application-level acceptance for install, setup, build,
  named-pipe requests, Dashboard, and version reporting.
- A helper-owned Windows control pipe with a verified protected DACL limited to
  the service identity, LocalSystem, and BUILTIN\Administrators.

## Future work

New feature requests and their acceptance progress are tracked in the
[Feature requirements](feature-requirements.md) ledger, separately from release
availability.

- Release-packaged native Windows Service installation plus strict state,
  secret, and Baileys ACL enforcement on the designated host. A one-time WinSW
  lifecycle acceptance and strict control-pipe ACL acceptance have passed.
- Exact-tag revalidation for the provider and Linux boundaries listed in
  [Release status](release-status.md).

Search analytics, automatic translation, a dynamic adapter plugin runtime, and
an external vector or telemetry backend are not planned prerequisites for the
first release.
