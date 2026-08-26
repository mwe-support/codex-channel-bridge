# Development baseline

## Current implementation slice

The first runtime slice establishes only the Codex-facing path:

1. `@codex-channel-bridge/core` defines shared Profile health vocabulary.
2. `@codex-channel-bridge/codex-app-server` owns newline-delimited JSON
   framing, request correlation, generated-schema capability probes, and the
   supervised App Server child edge.
3. `@codex-channel-bridge/profile-worker` owns one Profile-exclusive child,
   readiness, Thread start or reuse, Turn start, and terminal result
   collection.
4. `@codex-channel-bridge/config` owns strict YAML parsing, environment
   overrides, complete static validation, and Configuration Revision hashing.
5. `@codex-channel-bridge/supervisor` owns the foreground deployment process,
   accepted desired configuration, multi-Profile transitions, and the Worker
   child-process Adapter.
6. `@codex-channel-bridge/cli` exposes host-local development commands.

No package stores Codex Thread or Turn history. The Profile worker sends native
App Server requests and consumes native item and Turn events.

## Toolchain

- Node.js 22 or newer
- npm 10 or newer
- TypeScript 5.9
- an administrator-supplied `codex` executable

Install and run the unit suite:

```sh
npm install
npm test
```

## Tested Codex matrix

| Codex CLI | Stable v2 schema SHA-256 | Status |
| --- | --- | --- |
| `0.149.1` | `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9` | tested |

The source-of-truth manifest is
`protocol/codex/0.149.1/manifest.json`. The Bridge regenerates the schema from
the actual configured executable. It fails closed below the minimum version or
when a required stable method is missing. A newer compatible schema is allowed
but reported as `unverified`.

Run the real, Thread-free contract test:

```sh
npm run test:contract
```

This performs `initialize`, sends `initialized`, and calls `model/list`. It does
not create a Codex Thread or Turn.

Run the real process-tree contract test:

```sh
npm run test:supervisor-contract
```

This starts one healthy Profile and one deliberately unavailable Profile. It
verifies that the Supervisor remains live, the healthy Worker reaches `ready`,
the unavailable sibling fails closed, and both Worker processes stop without
creating a Turn.

## Optional end-to-end smoke Turn

The smoke test uses the operator's supplied Codex home and consumes a real
Codex Turn. It creates a real Codex Thread in the selected Workspace. Run it
only when that side effect is intended:

```sh
CODEX_HOME=/absolute/codex/home \
BRIDGE_SMOKE_WORKSPACE=/absolute/workspace \
npm run test:smoke
```

The equivalent CLI path reads Codex input from stdin so message text is not a
command-line argument:

```sh
printf 'Reply briefly.' | node packages/cli/dist/main.js codex turn \
  --profile local-dev \
  --workspace /absolute/workspace \
  --codex-home /absolute/codex/home
```

## Protocol behavior

- App Server stdout is protocol-only. Blank or non-JSON output is a protocol
  fault and rejects all pending requests.
- App Server stderr is consumed separately. The first slice retains only
  bounded content-free byte and chunk counts, never raw stderr text.
- Experimental APIs are not enabled.
- Unhandled server-originated Approval Requests or user-input requests receive
  a JSON-RPC method-not-found response. This fails closed until Channel
  approval transport is implemented.
- Model selection, reasoning, Reviewer policy, sandboxing, compaction, and
  Thread persistence remain Codex-owned.

## Current development limits

- Configuration is accepted on explicit foreground Supervisor start. Runtime
  `config apply` awaits the authenticated host-local IPC control plane; the
  process does not watch `config.yaml` or reload on signals.
- Worker process crashes are reported as Profile-local `unavailable`; bounded
  automatic Worker restart policy is not implemented yet.
- Profile drain currently stops the App Server because Channel admission,
  active-Turn tracking, Approval transport, queues, and the durable outbox are
  not present yet. Their eventual drain conditions remain defined by the ADRs.
