---
title: Limits and roadmap
---

# Limits and roadmap

## First-release limits

- Shared-OS-user Profiles provide application-layer isolation, not hostile
  process isolation. Use separate OS users or containers for stronger isolation.
- Administration is host-local structured IPC only. There is no web console,
  remote App Server attachment, or administration TCP port.
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

## Future work

- Real native Windows service and named-pipe ACL acceptance after a Windows
  verification host is designated.
- Exact-tag revalidation for the provider and Linux boundaries listed in
  [Release status](release-status.md).
- A web administration UI only after its authentication, authorization,
  lifecycle, and local/remote trust boundary has a separate accepted design.

Search analytics, automatic translation, a dynamic adapter plugin runtime, and
an external vector or telemetry backend are not planned prerequisites for the
first release.
