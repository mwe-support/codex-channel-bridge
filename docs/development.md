# Development baseline

## Current implementation slices

The current runtime slices establish these explicit package boundaries:

1. `@codex-channel-bridge/core` defines shared Profile health vocabulary and
   the channel-neutral Adapter contract.
2. `@codex-channel-bridge/codex-app-server` owns newline-delimited JSON
   framing, request correlation, generated-schema capability probes, and the
   supervised App Server child edge.
3. `@codex-channel-bridge/profile-worker` owns one Profile-exclusive child,
   readiness, Thread start or reuse, Turn start, and terminal result
   collection.
4. `@codex-channel-bridge/config` owns strict YAML parsing, environment
   overrides, Secret Reference resolution, complete static validation, and
   Configuration Revision hashing.
5. `@codex-channel-bridge/profile-store` owns the Profile-exclusive WAL
   SQLite schema, provider-event deduplication, recent-message reads, and FTS5
   lexical search. Its asynchronous interface dispatches synchronous SQLite
   work to a dedicated Worker thread.
6. `@codex-channel-bridge/supervisor` owns the foreground deployment process,
   accepted desired configuration, multi-Profile transitions, and bounded
   Worker child-process restart policy.
7. `@codex-channel-bridge/control-plane` owns the versioned local JSONL
   administration contract, platform endpoint edge, authorization hook, and
   two-phase configuration plan/apply protocol.
8. `@codex-channel-bridge/cli` exposes host-local development commands.
9. `@codex-channel-bridge/qq-adapter` pins Tencent's official QQ Bot SDK,
   normalizes C2C and group events, and maps text delivery outcomes without
   owning routing or Codex behavior.

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

## Platform verification priority

Implement and accept platform behavior in this order:

1. Native macOS on the local development machine.
2. Native Linux on the remote host addressed by SSH alias
   `marvel-mini-pc`.
3. Linux Docker on `marvel-mini-pc` using that host's Docker engine.

Run each platform-specific contract, process-lifecycle, filesystem-permission,
signal/drain, and packaging test on its actual target. A macOS result does not
validate either Linux target, and a native Linux result does not validate the
container image. Windows remains a first-release target but is deferred until
these three targets pass and a real Windows verification host is designated.

Before a run, inspect the target's current Node.js, npm, Docker where relevant,
and administrator-supplied Codex versions. Report a missing prerequisite as an
environment gap. The Bridge and its validation workflow must not install or
upgrade Codex on either host.

### Verification snapshot: 2026-08-26

| Target | Runtime | Result |
| --- | --- | --- |
| Native macOS | Node `22.23.1`, npm `10.9.8`, Codex `0.149.1` | 51 unit tests, 3 control-plane contracts, Supervisor process contract, Codex protocol contract, and npm audit passed |
| Native Linux (`marvel-mini-pc`) | Ubuntu kernel `6.8`, Node `22.22.1`, npm `10.9.4`, Codex `0.149.1` | Fresh `npm ci`, the same unit/control/Supervisor/Codex contracts, and npm audit passed |
| Linux Docker (`marvel-mini-pc`) | `node:22-bookworm`, Node `22.23.2`, npm `10.9.8`, mounted read-only Codex `0.149.1`, fresh empty Codex home | Fresh `npm ci`, the same unit/control/Supervisor/Codex contracts, and npm audit passed |

The Docker run did not mount the host Codex home or authentication state. The
slim Node image could not build `better-sqlite3` because it lacks Python and a
C/C++ toolchain; the full Bookworm image supplied the expected Build Stage and
passed. This verifies runtime behavior, not a production multi-stage image,
which is still future packaging work.

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

## Optional real QQ contract

The QQ live contract connects to the configured test robot, waits for one C2C
or group event, and passively replies with a fixed marker. It never prints a
message body, provider identity, credential, Secret Reference name, or provider
message ID. It does send one real QQ reply, so run it only when that side effect
is intended:

```sh
BRIDGE_QQ_LIVE_SECRETS_FILE=/absolute/path/to/secrets.env \
npm run test:qq-live
```

The explicitly selected owner-only file may use one conventional QQ credential
pair. Nonstandard dotenv names can be selected without passing values as
arguments by setting `BRIDGE_QQ_APP_ID_REF` and
`BRIDGE_QQ_APP_SECRET_REF` in the process environment. See
`docs/qq-adapter.md` for the verified and still-open provider contracts.

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
  --codex-home /absolute/codex/home \
  --state-directory /absolute/bridge/state
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
- The Profile Store implements persistence, an off-event-loop storage Worker,
  and lexical FTS5 foundations only. Complete local Hybrid Retrieval, Archive
  MCP Server, Archive Purge, media persistence, and durable outbox are not
  implemented yet.
- The QQ Adapter connects and archives normalized C2C/group events, but access
  policy, Conversation-to-Thread routing, passive reply sequence persistence,
  durable outbox retry, and Codex result delivery are not implemented yet.
