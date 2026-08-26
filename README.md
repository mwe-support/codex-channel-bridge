# Codex Channel Bridge

Codex Channel Bridge is a standalone, self-hosted bridge between external messaging channels and Codex App Server. It is designed to connect QQ through Tencent's official SDK and WhatsApp through Baileys without depending on Hermes, OpenClaw, or another agent-gateway runtime.

## Status

This repository now contains the first two development slices: a typed stdio
JSONL Codex client and a foreground multi-Profile Supervisor. The Supervisor
loads a strictly validated configuration and owns one Worker child per enabled
Profile; each Worker owns its exclusive App Server child. QQ, WhatsApp, durable
delivery, administration IPC, and production packaging are not implemented
yet, so the Bridge is not ready for deployment.

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
- [Development and Codex protocol verification](docs/development.md)
- [Configuration and Supervisor operation](docs/configuration.md)

The inherited Hermes worktree was used only as research context. Its runtime plugins, deployment files, history, and remote are not part of this repository.

## Development

The first slice requires Node.js 22 or newer and an administrator-supplied
Codex CLI. The Bridge never installs or upgrades Codex.

```sh
npm install
npm test
npm run test:contract
npm run test:supervisor-contract
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

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
