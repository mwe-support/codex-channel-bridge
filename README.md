# Codex Channel Bridge

Codex Channel Bridge is a standalone, self-hosted bridge between external messaging channels and Codex App Server. It is designed to connect QQ through Tencent's official SDK and WhatsApp through Baileys without depending on Hermes, OpenClaw, or another agent-gateway runtime.

## Status

This repository contains a typed stdio JSONL Codex client, a foreground
multi-Profile Supervisor, a structured host-local administration control plane,
Profile-local Message Archive persistence, a first-party QQ SDK adapter, and a
pinned Baileys WhatsApp adapter baseline with an owner-only atomic Auth
Generation Store and staged pairing transaction.
The Supervisor loads a strictly validated configuration and owns
one Worker child per enabled Profile; each Worker owns its exclusive App Server
child, Profile-local WAL SQLite state, and independently supervised Channel
Adapters. Inbound Channel events are normalized and durably deduplicated before they
pass through fail-closed access, bounded admission, durable Thread Binding,
native Turn start/steer, Logical Result commit, and Outbox delivery.
The control plane supports status and explicitly confirmed runtime
configuration changes without TCP or HTTP. Stable Codex command and file-change
Approval Requests are correlated to the exact initiating Channel participant.
Their bounded prompt is committed through the durable Outbox, provider
presentation and Channel callback state are persisted, and body-free Approval
Audit Records survive process restart.
App Server generations now restart behind a Profile-local circuit, resume and
read nonterminal Codex correlations without replaying them, and participate in
bounded Profile drain. Recovery-discovered uncertainty is atomically committed
with a durable Channel notification. Host-local WhatsApp pairing control/media
behavior and production packaging remain incomplete, so the Bridge is not ready
for deployment.

## First-release direction

- Connect Channel messages directly to one Profile-exclusive Codex App Server child over local stdio JSONL.
- Keep Codex authoritative for Threads, Turns, history, compaction, approvals, sandboxing, models, tools, skills, MCP configuration, and authentication.
- Keep the Bridge responsible only for Channel adaptation, Profile isolation, routing, access, durable delivery, Channel archive, and approval transport.
- Support multiple mutually untrusted Profiles at the application layer.
- Target native macOS, native Linux, native Windows, and Linux Docker.
- Ship QQ and WhatsApp together behind one channel-neutral core contract.

## Design documents

- [Agent and implementation constraints](AGENTS.md)
- [Domain glossary](CONTEXT.md)
- [Architecture decisions](docs/adr/)
- [Codex-native history and compaction research](docs/research/codex-native-thread-history-retrieval-and-compaction.md)
- [Open-source implementation landscape](docs/research/github-codex-channel-bridge-landscape.md)
- [Tencent QQ SDK contract research](docs/research/qq-official-sdk-contract.md)
- [Development and Codex protocol verification](docs/development.md)
- [Configuration and Supervisor operation](docs/configuration.md)
- [Message Archive persistence baseline](docs/message-archive.md)
- [Access and admission](docs/admission.md)
- [Thread Binding and Codex input correlation](docs/thread-binding.md)
- [Logical Result and durable Outbox](docs/delivery.md)
- [Codex Approval Request routing](docs/approval-routing.md)
- [QQ adapter baseline](docs/qq-adapter.md)
- [WhatsApp adapter baseline](docs/whatsapp-adapter.md)

The inherited Hermes worktree was used only as research context. Its runtime plugins, deployment files, history, and remote are not part of this repository.

## Development

The first slice requires Node.js 22 or newer and an administrator-supplied
Codex CLI. The Bridge never installs or upgrades Codex.

```sh
npm install
npm test
npm run test:contract
npm run test:supervisor-contract
npm run test:control-contract
```

`test:contract` is read-only with respect to Codex Threads: it regenerates the
stable App Server schema, checks the pinned hash, initializes a real stdio App
Server, and calls `model/list`. See `docs/development.md` before running the
separate smoke Turn.

Validate a configuration without changing runtime state:

```sh
node packages/cli/dist/main.js config check \
  --config /absolute/path/config.yaml
```

Start the current development Supervisor in the foreground:

```sh
node packages/cli/dist/main.js supervisor run \
  --config /absolute/path/config.yaml
```

Query that running Supervisor and apply a candidate in two explicit steps:

```sh
node packages/cli/dist/main.js status
node packages/cli/dist/main.js config apply \
  --config /absolute/path/config.yaml
node packages/cli/dist/main.js config apply \
  --config /absolute/path/config.yaml \
  --confirm FULL_CANDIDATE_REVISION
```

The first apply command only returns a redacted plan. The second rereads and
validates the candidate, then requires its complete revision before changing
runtime state. See [Configuration and Supervisor operation](docs/configuration.md)
for endpoint and platform limits.

An older Profile database is never migrated during startup. Inspect and apply
the currently supported schema 3, 4, or 5 to 6 migration through the same host-local
control plane:

```sh
node packages/cli/dist/main.js migrate plan --profile alpha
node packages/cli/dist/main.js migrate apply \
  --profile alpha \
  --backup-manifest /absolute/path/alpha-snapshot-manifest.json \
  --confirm FULL_PLAN_DIGEST \
  --snapshot-confirmed yes
```

The apply command requires evidence for an externally completed snapshot; the
Bridge does not create or upload that backup. See [Explicit Profile schema
migration](docs/migrations.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
