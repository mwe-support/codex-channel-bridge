# Codex Channel Bridge

Codex Channel Bridge is a standalone, self-hosted bridge between external messaging channels and Codex App Server. It is designed to connect QQ through Tencent's official SDK and WhatsApp through Baileys without depending on Hermes, OpenClaw, or another agent-gateway runtime.

## Status

This repository is an architecture and research baseline. The Bridge runtime has not been implemented yet and is not ready for deployment.

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

The inherited Hermes worktree was used only as research context. Its runtime plugins, deployment files, history, and remote are not part of this repository.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
