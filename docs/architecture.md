---
title: Architecture and ownership
---

# Architecture and ownership

## Process boundary

One deployment runs one foreground Supervisor. It owns one Worker per enabled
Profile; every Worker owns one administrator-supplied Codex App Server child
and independently supervised Channel adapters. Profiles never share an App
Server, Codex home, Workspace, state database, media directory, or Channel
Account.

```text
service manager
  -> Bridge Supervisor
       -> Profile Worker
            -> Codex App Server (stdio JSONL)
            -> QQ adapter
            -> WhatsApp adapter
```

The first release uses local stdio for App Server and owner-only local IPC for
administration. It opens no TCP, WebSocket, HTTP, or web-administration service.

## Ownership

| Owner | Authoritative state |
| --- | --- |
| Codex App Server | Thread, Turn, items, history, compaction, approvals, sandbox, permissions, models, tools, skills, MCP, Codex authentication |
| Bridge | Profile, Channel Account and Binding, Access Policy, provider normalization, Thread Binding IDs, Message Archive, input correlation, durable outbox, delivery receipts |
| Channel provider | Provider message, participant and conversation identifiers, send responses, and exposed events |

The Bridge calls the native App Server lifecycle: `thread/start` creates a
Thread, `thread/resume` loads an existing binding, `turn/start` starts work,
`turn/steer` adds input to an active Turn, and `turn/interrupt` stops it. It
does not rebuild those semantics. See the
[official App Server documentation](https://learn.chatgpt.com/docs/app-server).

## Package map

- `core`: shared contracts, commands, access, and admission vocabulary.
- `config` and `profile-store`: validated Bridge configuration and one
  Profile-local SQLite store.
- `codex-app-server` and `profile-worker`: native protocol edge and Profile
  lifecycle composition.
- `qq-adapter` and `whatsapp-adapter`: provider-specific facts and receipts.
- `supervisor`, `control-plane`, and `cli`: deployment lifecycle and host-local
  administration.

For implementation and contract-test guidance, read [Development](development.md).
