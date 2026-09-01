# Development baseline

## Current implementation slices

The current runtime slices establish these explicit package boundaries:

1. `@codex-channel-bridge/core` defines shared Profile health vocabulary, the
   channel-neutral Adapter contract, provider-fact events, and trusted Channel
   context types without performing I/O.
2. `@codex-channel-bridge/codex-app-server` owns newline-delimited JSON
   framing, request correlation, generated-schema capability probes, and the
   supervised App Server child edge.
3. `@codex-channel-bridge/profile-worker` owns one Profile-exclusive child,
   readiness, trusted Channel context injection, the single Profile-local
   Inbound Pipeline, the single `CodexEventRouter`, native Turn coordination,
   and terminal result collection.
4. `@codex-channel-bridge/config` owns strict YAML parsing, environment
   overrides, Secret Reference resolution, complete static validation, and
   Configuration Revision hashing.
5. `@codex-channel-bridge/profile-store` owns the Profile-exclusive WAL
   SQLite schema, provider-event deduplication, recent-message reads, FTS5
   lexical search, Thread Bindings, Codex input correlations, atomic Logical
   Result commits, and durable Outbox state transitions. Its asynchronous
   interface dispatches synchronous SQLite work to a dedicated Worker thread.
   Its explicit migration edge currently supports schema 3, 4, 5, 6, 7, or 8 to 9.
6. `@codex-channel-bridge/supervisor` owns the foreground deployment process,
   accepted desired configuration, multi-Profile transitions, and bounded
   Worker child-process restart policy. It serializes stopped Profile
   maintenance without stopping siblings.
7. `@codex-channel-bridge/control-plane` owns the versioned local JSONL
   administration contract, platform endpoint edge, authorization hook, and
   two-phase configuration and migration plan/apply protocols.
8. `@codex-channel-bridge/cli` exposes host-local development and migration
   commands.
9. `@codex-channel-bridge/qq-adapter` pins Tencent's official QQ Bot SDK,
   normalizes C2C and group provider facts, and maps text delivery outcomes
   without declaring a Profile, Account Epoch, routing decision, or Codex
   behavior in its inbound events.
10. `@codex-channel-bridge/whatsapp-adapter` pins `baileys@7.0.0-rc14`,
    normalizes live private/group text, maps send acceptance, and owns the
    owner-only atomic rotating-auth file edge without claiming Profile routing.

No package stores Codex Thread or Turn history. The Profile worker sends native
App Server requests and consumes native item and Turn events.

The Bridge-owned Thread Binding and input-correlation ordering is documented in
[`thread-binding.md`](thread-binding.md). Normalized input passes through Access
Policy, command parsing, and Profile-local Admission Control before native
`thread/start`, `thread/resume`, `turn/start`, or `turn/steer` work.

### Profile-local Codex event routing

`ProfileWorker` installs exactly one App Server notification listener for its
runtime generation. It forwards relevant terminal events into
`CodexEventRouter` and remains the lifecycle composition root. A new
`TurnCoordinator` performs native `thread/start` and `turn/start` requests and
waits for the router's terminal result.

The coordinator reserves one registration for a Thread before sending
`turn/start`. Early `item/completed` and `turn/completed` signals are buffered
by their candidate Turn ID, then only the bucket matching the Turn ID returned
by `turn/start` is claimed. This avoids treating `clientUserMessageId` as a
notification correlation key; the generated stable schema does not echo that
field on notifications. Different Threads can run concurrently, while a second
pending or active Turn on the same Thread is rejected as ambiguous.

The early-signal buffer is bounded to 1,000 relevant signals per pending
Thread. Timeout, cancellation, Profile stop, and App Server protocol fault all
release their registrations. Router state is process-generation correlation
only: it is not Codex Thread history, durable Turn state, or restart
reconciliation.

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

### Verification snapshots

| Target | Runtime | Result |
| --- | --- | --- |
| Native macOS, 2026-09-01 | macOS `26.6.2`, Node `22.23.1`, npm `10.9.8`, Codex `0.149.1` | Clean build, 217 unit tests, 2 platform-definition tests, 4 control-plane contracts, Supervisor process contract, Codex protocol contract, a real per-user launchd lifecycle, and live QQ acceptance passed |
| Native Linux (`marvel-mini-pc`), 2026-09-01 | Ubuntu `24.04`, kernel `6.8.0-106-generic`, Node `22.22.1`, npm `10.9.4`, Codex `0.149.1` | Fresh `npm ci`, 217 unit tests, 2 platform-definition tests, 4 control-plane contracts, Supervisor process contract, Codex protocol contract, and a real user-systemd lifecycle passed |
| Linux Docker (`marvel-mini-pc`), 2026-09-01 | Docker `29.3.0`, `node:22.23.1-bookworm-slim`, image-pinned Codex `0.149.1`, fresh empty Codex home | Production multi-stage image built; non-root runtime, no published port, liveness health check, Profile readiness, and graceful `SIGTERM` drain passed |

The Docker run did not mount the host Codex home or authentication state. The
full Bookworm build stage supplies the native toolchain for `better-sqlite3`;
the slim runtime contains only production dependencies and the pinned Codex
CLI. See [`acceptance/platform-stage-7.md`](acceptance/platform-stage-7.md).

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
- The App Server child receives an explicit execution, locale, proxy, and CA
  environment allowlist plus its Profile-local `CODEX_HOME`. The Bridge does
  not forward Channel credentials, Bridge configuration overrides,
  deployment-wide API keys, or an enclosing Codex Desktop session's tool pipe,
  permission profile, Thread, or Session identifiers. Codex authentication for
  this release must reside in the isolated Profile Codex home.
- App Server stderr is consumed separately. The first slice retains only
  bounded content-free byte and chunk counts, never raw stderr text.
- Experimental APIs are enabled only when the generated schema advertises the
  optional `thread/settings/update` method. Its absence disables `/model` and
  `/reasoning`; the Bridge does not emulate native Thread settings.
- One Profile runtime has one notification listener and one generation-local
  event router. Per-Turn notification listeners are not used.
- Stable command-execution and file-change Approval Requests are routed by their
  original JSON-RPC request ID to the exact active Turn initiator. Unsupported
  approval shapes and experimental user-input requests fail closed.
- Model selection, reasoning, Reviewer policy, sandboxing, compaction, and
  Thread persistence remain Codex-owned.

## Current development limits

- Runtime `config apply` is available only through the host-local control plane
  and complete-revision confirmation. The process does not watch `config.yaml`
  or reload on signals.
- A crashed Worker is restarted Profile-locally after bounded delays of one,
  two, and five seconds within a sixty-second window. A further crash opens the
  Profile-local stop condition `worker_restart_exhausted`; the Supervisor and
  sibling Profiles remain live. A thirty-second cooldown resets the bounded
  budget before one new Worker generation is attempted. An administrator can
  explicitly reset the circuit through the host-local control plane.
- Unix access currently relies on verified service-user ownership and modes
  because Node.js does not expose peer credentials. The Windows named-pipe path
  is present, but strict ACL setup and verification remain untested platform
  work. No Web Administration Console is implemented.
- Profile drain rejects new Turn and steer admission, expires queued work, and
  waits for active Turns, process-scoped Approval Requests, and pending Outbox
  delivery. At its deadline it invokes native `turn/interrupt`, closes the
  generation-scoped routers, and stops adapters only after the delivery window.
  Approval prompts use the same durable Outbox as terminal results. Request
  state and body-free Audit Records are Profile-local; process-scoped native
  request IDs are never replayed, and a generation boundary rejects stale
  unsent presentation before the replacement generation accepts work.
- The Profile Store implements persistence, an off-event-loop storage Worker,
  local multi-signal Hybrid Retrieval, a Profile-local read-only Archive MCP,
  Archive Purge, bounded media persistence, Profile Purge, atomic Logical
  Result commit, and durable Outbox state transitions.
  Explicit migration currently supports only the known schema 3, 4, 5, 6, 7, or 8 to 9 spans;
  other version spans remain unsupported and fail closed.
- The QQ Adapter emits only C2C/group provider facts. The Profile-local Inbound
  Pipeline injects Profile, Channel Account, and Account Epoch authority,
  derives the Conversation Key, archives before exposure, and suppresses
  duplicates. Access Policy, command parsing, Profile-local Admission, native
  Thread start/resume, native Turn start/steer, input correlation, Logical
  Result creation, and durable Outbox dispatch are connected. Initiator-bound
  `/stop` uses native `turn/interrupt`; `/approve` returns a bound decision to
  the original native request. App Server exits and protocol faults now close
  process-scoped requests, mark in-flight correlation uncertain, retry behind a
  bounded jittered circuit, and use native `thread/resume` plus
  `thread/read(includeTurns)` before accepting new work. Recovered input is never
  replayed automatically. An uncertainty found during restart is atomically
  committed with its Channel Logical Result and durable Outbox records.
  `/help` and `/status` are local projections; `/new`, `/attach`, and `/detach`
  mutate only the Bridge-owned Thread Binding; `/model` and `/reasoning` use
  the probed native `thread/settings/update` method. Shared conversation-scoped
  group settings fail closed because Channel-side administrator capabilities
  are not implemented.
  Passive QQ reply
  sequences are now allocated with the Outbox transaction and forwarded through
  the explicit raw-send path. The QQ SDK still does not expose a
  provider idempotency key or reconciliation lookup, so ambiguous sends retain
  a disclosed duplicate window.
- The WhatsApp Adapter handles live text, mention/passive distinction, send
  acceptance, an atomic Profile-local Auth Generation Store, staged pairing,
  Provider Identity verification, host-local lifecycle control, single-adapter
  replacement, durable revocation uncertainty, and restart-safe quoted replies.
  Decrypted media is streamed once into the bounded Profile Media Archive.
  Retryable disconnects replace the Socket
  through a bounded three-attempt backoff; administrative disconnect reasons
  and exhaustion degrade only that adapter. The Channel-neutral readiness edge
  projects later degradation and recovery into Profile Health. Missing or
  insecure auth also degrades only that adapter.
