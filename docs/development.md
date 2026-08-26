# Development baseline

## Current implementation slices

The current runtime slices establish these explicit package boundaries:

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
   accepted desired configuration, multi-Profile transitions, and bounded
   Worker child-process restart policy.
6. `@codex-channel-bridge/control-plane` owns the versioned local JSONL
   administration contract, platform endpoint edge, authorization hook, and
   two-phase configuration plan/apply protocol.
7. `@codex-channel-bridge/cli` exposes host-local development commands.

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

Run the real Unix control-plane contract test:

```sh
npm run test:control-contract
```

This verifies an owner-only socket, structured request/response framing,
per-request authorization, denial behavior, and refusal to replace an active
endpoint. It requires a host environment that permits Unix-domain sockets.

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

- Runtime `config apply` is available only through the host-local control plane
  and complete-revision confirmation. The process does not watch `config.yaml`
  or reload on signals.
- A crashed Worker is restarted Profile-locally after bounded delays of one,
  two, and five seconds within a sixty-second window. A further crash opens the
  Profile-local stop condition `worker_restart_exhausted`; the Supervisor and
  sibling Profiles remain live. Administrator reset and cooldown-based recovery
  are not implemented yet.
- Unix access currently relies on verified service-user ownership and modes
  because Node.js does not expose peer credentials. The Windows named-pipe path
  is present, but strict ACL setup and verification remain untested platform
  work. No Web Administration Console is implemented.
- Profile drain currently stops the App Server because Channel admission,
  active-Turn tracking, Approval transport, queues, and the durable outbox are
  not present yet. Their eventual drain conditions remain defined by the ADRs.
