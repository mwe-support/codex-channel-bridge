# Negotiate actual Codex capabilities; record versions as evidence

Next amendment, accepted 2026-09-05: remove the previous version floor and fixed
CLI/schema expectations. The administrator supplies Codex. At Profile startup,
generate schemas from that executable and verify required methods plus live
initialization and model discovery. Missing required capabilities fail that
Profile closed; absent optional capabilities disable only their enhancements.
Look for optional methods on the stable surface first, then the experimental
surface, allowing promotion without a Bridge release.

Actual version and schema digest are diagnostic and acceptance evidence, not an
allowlist. Preserve historical tested snapshots; all other combinations remain
unverified even when startup probes pass. The host contract runs against the
configured executable without asserting one version/hash or requiring optional
methods. Probes do not establish every runtime behavior: retain Turn, approval,
recovery and Channel acceptance tests. Never mutate the host Codex installation.
Docker requires an explicit builder-selected package version for reproducibility;
the runtime still uses capability checks and never updates itself.

Sources: [official schema generation and initialization](https://learn.chatgpt.com/docs/app-server#message-schema)
and the [0.153.4 schema export implementation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/src/export.rs).
