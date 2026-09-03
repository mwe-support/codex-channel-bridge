---
sidebar_position: 1
slug: /
title: Codex Channel Bridge
---

# Codex Channel Bridge

Codex Channel Bridge is a self-hosted adapter between QQ or WhatsApp and Codex
App Server. It lets an admitted Channel Conversation create, resume, steer, and
receive results from a native Codex Thread inside one isolated Profile.

The Bridge is **not an agent gateway**. Codex owns Threads, Turns, history,
compaction, approval schemas, sandbox and permission policy, models, tools,
skills, MCP, and authentication. The Bridge owns Channel access, provider-event
normalization, conversation-to-Thread bindings, delivery correlation, durable
outbox retries, and the Channel-only Message Archive.

## Start here

- [Quickstart](getting-started.md) — build and run the current prerelease.
- [Architecture and ownership](architecture.md) — understand the process and
  state boundaries before operating it.
- [Configuration](configuration.md) — define Profiles, Workspaces, Channel
  Accounts, Access Policies, and Secret References.
- [Channel commands](commands.md) — use Thread, Turn, model, reasoning, and
  approval projections from QQ or WhatsApp.
- [Local dashboard](dashboard.md) — inspect the running version, health, Channel
  connectivity, and confirmed settings changes.
- [Release status](release-status.md) — distinguish accepted behavior, exact-tag
  revalidation gaps, and future work.
- [Limits and roadmap](limits-and-roadmap.md) — see the intentionally deferred
  features and platform boundaries.

## Documentation versions

`Next` describes the moving `main` branch and is not a release. The version
selector also exposes immutable prerelease documentation generated from the
matching Git tag. There is no `latest` route until a stable release exists.
The build manifest at `/version-manifest.json` records the source commit, tag,
product version, documentation version, release date, and archive checksum.

Every public English page has a semantically equivalent page at the same path
under `docs/zh`. Use the language selector to switch between them.
