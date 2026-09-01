# Documentation

The documentation version is recorded in [`VERSION`](VERSION). Documentation
on `main` describes the next release and may change. For an installed release, always use
the documents stored in the matching `vMAJOR.MINOR.PATCH` Git tag or attached
to that GitHub Release. Do not use `main` documentation to operate an older
deployment.

## Operators

Read these documents in order for a new deployment:

1. [`deployment.md`](deployment.md) selects a tagged release and installs the
   foreground Supervisor on macOS, Linux, or Linux Docker.
2. [`configuration.md`](configuration.md) defines Profiles, Workspaces,
   Channel Accounts, Access Policies, Secret References, and validation.
3. [`qq-adapter.md`](qq-adapter.md) or
   [`whatsapp-adapter.md`](whatsapp-adapter.md) provisions the selected Channel.
4. [`operations.md`](operations.md) covers health, doctor, backup holds, Audit
   Records, Support Bundles, and circuit recovery.
5. [`migrations.md`](migrations.md) is required before changing a Bridge version
   that introduces a Profile database schema change.

Delivery, admission, approval, and archive behavior are specified in
[`delivery.md`](delivery.md), [`admission.md`](admission.md),
[`approval-routing.md`](approval-routing.md), and
[`message-archive.md`](message-archive.md).

## Channel users and Profile administrators

- [`thread-binding.md`](thread-binding.md) explains conversation-to-Thread
  binding and the `/new`, `/attach`, `/detach`, `/model`, and `/reasoning`
  projections.
- [`approval-routing.md`](approval-routing.md) explains who can answer a Codex
  Approval Request and how stale requests fail closed.
- The QQ and WhatsApp adapter guides state the exact private-chat, group-chat,
  reply, mention, media, and authentication boundaries of each provider.

## Contributors and downstream developers

Start with [`../CONTEXT.md`](../CONTEXT.md), then read
[`development.md`](development.md) for package ownership, local setup, contract
tests, extension paths, and completion gates. Architecture decisions are in
[`adr/`](adr/); research snapshots are evidence, not runtime contracts.

Use [`release.md`](release.md) for version changes, changelog rules, release
candidates, tags, immutable artifacts, and documentation versioning. Every
English document under `docs/` has a semantically equivalent Chinese document
at the same path below [`zh/`](zh/).
