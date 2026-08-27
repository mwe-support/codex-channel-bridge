# Block Buzz: Architecture and Design Philosophy

- Research date: 2026-08-27 (Asia/Shanghai)
- Upstream snapshot: [`b622003f74aa5bf9b659786452813299a25e4897`](https://github.com/block/buzz/commit/b622003f74aa5bf9b659786452813299a25e4897)
- Scope: first-party material only — the Block-owned repository's README, vision and architecture documents, manifests, implementation, tests, CI, and release metadata.
- Evidence labels: **Source fact** means directly verified in code or configuration; **Upstream intent** means Buzz's own stated direction; **Inference** is this report's interpretation.

## Executive summary

Buzz is not principally an “AI chat client.” It is a self-hostable collaboration workspace whose unifying substrate is a Nostr relay. Human messages, agent work, reactions, workflow steps, git activity, and approvals are represented as signed events with one identity model and one searchable history. The relay is authoritative; clients do not gossip or replicate state peer-to-peer. Buzz itself is intended to be the event store, search, subscription, and delivery pipe, while humans and agents supply the intelligence. ([README](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L27-L42), [architecture](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L3-L18), [vision](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L1-L11))

The implementation is a modular Rust monorepo centered on one Axum relay process, with Postgres as the durable event/search store, Redis for cross-node pub/sub and ephemeral coordination, and S3/MinIO for media and git object storage. Desktop and web clients use TypeScript/React; desktop is Tauri 2, and mobile is Flutter. Agent integration is protocol-first: Buzz events reach an ACP harness; agents use ACP over stdio and tools use MCP over stdio. ([workspace manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/Cargo.toml#L1-L41), [README crate map](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L194-L240), [desktop manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/desktop/package.json#L1-L24), [mobile manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/mobile/pubspec.yaml#L1-L26))

Its strongest design idea is to make humans, agents, workflows, and repositories peers at the event/identity boundary instead of integrating separate products through bespoke glue. Its main trade-off is the reverse side of that bet: the relay becomes a large integration point, Nostr `kind` semantics and authorization must remain disciplined, and some current source has advanced faster than the repository's architecture/status prose.

## 1. Product position and boundaries

### What Buzz owns

**Source fact:** Buzz owns the workspace substrate: signed event ingestion, identity/authentication, channel membership, durable storage, search, live subscriptions, workflow triggering, media, git hosting, and audit. One community is selected from the request host; the host-derived community is bound before handlers see tenant data and cannot be overridden by client input. ([architecture summary](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L3-L18), [connection state](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L50-L80))

**Upstream intent:** “the relay is the workspace”: a community should combine conversation, agents, automation, artifacts, documentation, and repositories under one URL, identity system, and search index. ([vision](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L1-L11))

### What Buzz deliberately does not own

- It is not a blockchain, and signed events do not imply cryptocurrency or consensus machinery.
- It is not intended to replace humans; the project explicitly frames agents as collaborators in the room.
- It is not a finished implementation; the README distinguishes shipped, in-progress, and aspirational areas. ([README boundaries and status](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L98-L109), [“What it is not”](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L275-L287))

**Inference:** Buzz is closer to a self-hosted collaboration operating system or integrated forge/workspace than to Slack-with-a-bot. The project makes a platform-level bet that one event substrate can replace several separately indexed systems.

## 2. Technical stack and module layering

```text
Desktop / Web / Mobile       Agent runtimes       CLI and automation
         | WebSocket/HTTP       | ACP + MCP           | WebSocket/HTTP
         +----------------------+---------------------+
                                v
                    buzz-relay (Axum, Tokio)
        auth | ingest | subscriptions | workflows | git | media | audit
             |              |              |
             v              v              v
       Postgres 17        Redis 7        S3 / MinIO
     events + FTS     pub/sub + TTLs   media + git objects
```

### Layer 1: protocol kernel

`buzz-core` contains event types, signature/ID verification, filter matching, kind definitions, tenant primitives, and security helpers. Its manifest intentionally has no Tokio, SQLx, Redis, or Axum dependencies, preserving a zero-I/O domain layer. ([`buzz-core` manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-core/Cargo.toml#L1-L27))

The universal wire/domain object is the Nostr event: canonical ID, secp256k1 public key, integer `kind`, tags, content, and Schnorr signature. The `kind` number is the dispatch and extension switch; standard Nostr kinds and Buzz-specific ranges coexist. ([protocol and kind ranges](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L101-L163), [`kind.rs`](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-core/src/kind.rs#L1-L41))

### Layer 2: focused service crates

- `buzz-db`: Postgres persistence and transactional domain state.
- `buzz-auth`: NIP-42 WebSocket auth, NIP-98 HTTP auth, scopes, replay protection, and rate-limit interfaces.
- `buzz-pubsub`: Redis fan-out, presence, typing, cache invalidation, and the Redis-backed admission limiter.
- `buzz-search`: permission-aware candidate search over the event table's generated Postgres FTS column.
- `buzz-audit`: per-community hash-chain audit log.
- `buzz-workflow`: YAML definitions, triggers, actions, and execution state.
- `buzz-media`: Blossom/S3 media handling.

The declared dependency rule is that these services do not coordinate with each other directly; `buzz-relay` imports and orchestrates them. ([crate hierarchy](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L75-L99), [workspace members](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/Cargo.toml#L1-L34))

### Layer 3: relay composition root

`buzz-relay` is the sole composition point. Its `AppState` holds shared, mostly `Arc`-wrapped services and bounded concurrency/state primitives: DB and Redis pools, auth, search, subscriptions, connections, workflow engine, media and git stores, semaphores, bounded audit channel, TTL caches, replay guard, and rate limiters. ([current `AppState`](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L630-L760))

This is a modular-monolith/relay-core architecture rather than independent service deployment. Redis enables multiple stateless relay instances to fan events across nodes, but domain orchestration remains inside `buzz-relay`.

### Layer 4: clients and agent surface

- Desktop: React 19 + TypeScript + Vite inside Tauri 2; Playwright covers rendered flows.
- Web: a separate React/Vite package for browser/repository surfaces.
- Mobile: Flutter/Dart.
- Agents: `buzz-acp` bridges relay events to an ACP child; `buzz-agent` is an ACP agent; `buzz-dev-mcp` supplies tools; `buzz-cli` exposes JSON-oriented automation primitives. The SDK now also defines a broker contract for a **keyless** agent to ask a key-holding host to act for it. This commit provides only the contract, strict wire types, and client trait—not a broker host, concrete transport, relay integration, signing, or Desktop integration. ([agent architecture](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION_AGENT.md#L7-L42), [broker module boundary](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L1-L19), [explicit non-goals](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L46-L59))

## 3. Runtime and data flow

### 3.1 Connection and tenant binding

1. The request host resolves to a `TenantContext` before frames are accepted.
2. The relay acquires a connection semaphore permit; capacity exhaustion rejects immediately.
3. The relay sends a NIP-42 challenge and requires authentication within a bounded time.
4. Receive, send, and heartbeat loops run concurrently under one cancellation token.
5. Per-connection auth state uses an `RwLock`; subscription mutation uses a `Mutex`; data and control frames use separate bounded channels.
6. Cleanup removes subscriptions and connection registry state on every exit path. ([connection lifecycle design](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L165-L219), [current connection implementation](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L25-L116), [connection admission](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L140-L233))

### 3.2 Persistent event write

WebSocket `EVENT` and HTTP `POST /events` deliberately enter the same transport-neutral `ingest_event` pipeline. That shared seam applies tenant lifecycle fencing, auth/scope checks, signer checks, signature and canonical-ID verification, kind-specific validation, membership/role policy, and persistence. ([ingest module contract](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/ingest.rs#L1-L4), [shared ingest entry](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/ingest.rs#L2088-L2160))

Postgres insert uses `ON CONFLICT DO NOTHING`; event IDs therefore provide idempotent deduplication, and the DB API returns whether a row was actually inserted. AUTH and ephemeral events are rejected by the durable store. ([event store](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-db/src/event.rs#L1-L8), [insert path](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-db/src/event.rs#L300-L350))

After the durable write, Buzz awaits enqueueing the audit record into a bounded channel, then schedules post-commit Redis publication, local fan-out, and workflow triggering. The current implementation explicitly defines NIP-01 `OK` as durable acceptance, not completion of every downstream side effect. ([post-commit dispatcher](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/event.rs#L340-L391), [fan-out and workflow path](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/event.rs#L396-L548))

### 3.3 Ephemeral event path

Presence and typing-style events are verified and delivered through Redis/in-memory coordination but intentionally bypass durable event storage, search, and audit. This separates “current liveness signal” from “historical record.” ([ephemeral contract](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-db/src/event.rs#L1-L8), [architecture path](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L246-L268))

### 3.4 Subscription and read path

`SubscriptionRegistry` stores active filters in concurrent `DashMap` indexes keyed by community, channel, kind, and sometimes recipient. Targeted indexes avoid scanning every subscription for common fan-out cases. Registration is server-scoped to the resolved community. ([subscription indexes](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/subscription.rs#L70-L119))

Historical reads query Postgres; live events fan out in-process and through Redis for other relay instances. Delivery revalidates community and private-channel access at the send chokepoint, so a stale subscription or cache is not sufficient authorization. Local Redis echoes are suppressed with a TTL cache keyed by `(community_id, event_id)`. ([fan-out access gate](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/event.rs#L91-L237), [tenant-scoped echo cache](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L670-L710))

### 3.5 Agent flow

```text
Buzz event / @mention
  -> buzz-acp subscribes through relay WS
  -> per-channel queue, at most one prompt in flight
  -> ACP JSON-RPC over stdio to an agent
  -> agent calls per-session MCP servers over stdio
  -> tools perform work
  -> agent posts signed Buzz events through CLI/MCP
```

The design keeps agent protocol, tool protocol, and relay protocol separate. Sessions get independent MCP server processes/state; the agent is not linked to a particular tool implementation through imports. ([agent principles and topology](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION_AGENT.md#L21-L56), [ACP relay behavior](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L644-L676))

The new agent-to-broker seam adds a second, alternative action path for agents that do not hold a Nostr secret key: the agent prepares a typed `BrokerRequest`, freezes its serialized bytes, and sends it to one `/v1/action` endpoint with an opaque session credential; the host authenticates, authorizes, validates, executes, signs/publishes where needed, and returns a correlated envelope. The closed v1 action vocabulary has nine operations: channel read; post, reply, and react; set profile; derive a memory storage address; and create, update, or delete an agent. It intentionally exposes operations rather than raw `sign(bytes)`, enabling per-operation policy. ([contract topology and authority](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L9-L39), [action set](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/actions/mod.rs#L132-L180), [HTTP binding](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/client.rs#L1-L35))

Its reliability contract is unusually explicit: retry means identical frozen bytes under the same request ID; cursors are host-owned opaque tokens; successful reads contain signed Nostr events that a keyless agent can verify locally; a caller can obtain only a response already correlated and validated against its request; unknown fields and explicit `null` are rejected. A host refusal is a valid result, while lack of a usable envelope is transport-level **indeterminate**—side effects cannot be inferred, so the safe choices are identical-byte retry or state reconciliation. ([request and retry contract](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L97-L125), [validated client door](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/client.rs#L96-L123), [transport uncertainty](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/client.rs#L48-L81))

## 4. Key abstractions and extension points

| Abstraction | Role | Extension mechanism | Main cost |
|---|---|---|---|
| Signed Nostr event | Universal action/record envelope | Add a `kind`, validation, typed builder, persistence/read policy, and client renderer | Semantic discipline is required; “new kind” is wire-compatible but not implementation-free |
| `TenantContext` / `CommunityId` | Host-derived tenant label | Thread it through every read, write, cache, pub/sub, audit, git, and media path | A missing label is an isolation defect, so plumbing is pervasive |
| `buzz-core` | Pure protocol/domain kernel | Add types and verification without introducing I/O | Keeps testing simple but pushes orchestration outward |
| Service crate | Focused storage/auth/search/workflow boundary | Add a crate or a narrow service API; coordinate only in relay | Avoids service-to-service tangles; increases relay composition size |
| `AppState` | Runtime composition root | Register a service, cache, limiter, queue, or semaphore once | Central visibility is useful, but the state object is large |
| `SubscriptionRegistry` | Indexed live-query state | Add a bounded, tenant-labelled index for a new common access pattern | More indexes improve fan-out but complicate mutation/cleanup |
| YAML workflow | User-level automation | Add trigger/action enum variants and execution support | Schema can lead implementation; current approval/actions show this risk |
| ACP / MCP / provider binaries | Agent and tool boundaries | Swap agents, MCP servers, LLM providers, or remote backend executables | Subprocess lifecycle and protocol conformance become correctness boundaries |
| Broker `Action` / `BrokerClient` | Least-authority host actions for keyless agents | Add a reviewed typed operation; swap in-process and HTTP clients behind an object-safe trait | The closed vocabulary makes policy auditable, but every new operation is an intentional contract/versioning change; host implementation is not yet present |

**Inference:** Buzz's real extension API is not one plugin SDK. It is a combination of protocol kinds, crate boundaries, relay composition, workflow enums, CLI/MCP tools, and executable protocols. That is flexible but requires coordinated contract tests across several surfaces.

## 5. Concurrency, state, and errors

### Bounded concurrency and backpressure

- Connection, handler, git, media, workflow, and agent-session concurrency are bounded with semaphores or configured caps.
- Data and control WebSocket channels are separate; control frames retain priority when ordinary data buffers are full.
- Sustained slow-client backpressure cancels the connection rather than allowing unbounded queues.
- Heartbeats close stalled connections after missed pongs.
- Workflow capacity is fail-fast rather than an unbounded internal queue. ([connection state and send policy](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L50-L116), [handler admission](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L600-L711), [workflow bounds](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L509-L558))

### State placement

- Postgres is durable truth for events and relational domain state; search is a generated `tsvector` on stored event rows, not a separate external index.
- Redis holds cross-node delivery and expiring coordination such as presence, typing, replay seen-sets, and admission counters.
- S3/MinIO stores content-addressed media and git objects.
- Process memory holds connections, subscription indexes, bounded queues, room state, and TTL caches; these are disposable projections rather than the durable event source of truth. ([current state fields](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L630-L760), [Postgres FTS](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L464-L491))

### Error model

The transport-neutral ingest layer separates rejected client input, authentication/authorization failure, and internal failure; WebSocket and HTTP adapters map those categories to their own responses. Community lifecycle/database uncertainty fails closed. Metrics use bounded reason labels to avoid cardinality explosion. ([ingest error taxonomy](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/ingest.rs#L350-L405))

The durability semantics are deliberately asymmetric: a stored event can be acknowledged even if later Redis fan-out or workflow triggering fails, while a full bounded audit queue applies backpressure before acknowledgement. **Inference:** this favors durable acceptance and system availability over transactional atomicity across Postgres, Redis, subscribers, audit storage, and workflows. Operators therefore need observability/reconciliation for post-commit failures; Buzz is not implementing a distributed transaction across those systems.

## 6. Testing, build, and release

### Test strategy

**Source fact:** `just test-unit` runs no-infrastructure tests; `just test` also starts Postgres/Redis integration dependencies. Relay E2E suites require a live relay and are explicitly selected in CI. Desktop has TypeScript/unit checks, Tauri Rust tests, and sharded Playwright smoke/integration suites; mobile runs format, analyze, test, and Android debug build. Security/dependency policy uses `cargo-deny`, and Linux server binaries are cross-compiled for x86_64 and aarch64 musl. ([testing guide](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/TESTING.md#L3-L18), [CI unit and desktop lanes](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/.github/workflows/ci.yml#L96-L238), [relay E2E](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/.github/workflows/ci.yml#L777-L818), [mobile/security/cross-compile](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/.github/workflows/ci.yml#L900-L975))

CI first detects changed paths and skips irrelevant expensive lanes; pull-request runs cancel superseded work. Actions are pinned to commit SHAs. ([CI entry](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/.github/workflows/ci.yml#L1-L68))

### Build and packaging

Hermit pins the developer toolchain; `just` is the task front end; Cargo builds the Rust workspace and pnpm manages desktop/web/admin packages. The local stack uses Docker Compose with Postgres, Redis, and MinIO. Production supports a relay container, while desktop packaging targets macOS, Linux, and Windows. ([quick start](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L155-L182), [workspace package setup](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/package.json#L1-L13))

### Release model

Desktop, relay, and mobile have independent release lanes and versions. Desktop and relay use reviewed release PRs and immutable tags; mobile uses immutable release-candidate tags from the exact remote `main` commit. Desktop publishing separates a versioned release from later manual auto-update promotion, limiting blast radius. ([release lanes](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/RELEASING.md#L1-L45), [desktop/relay/mobile mechanics](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/RELEASING.md#L46-L128), [publication and promotion](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/RELEASING.md#L199-L227))

## 7. Core design philosophy and trade-offs

### 7.1 One identity model, one event log

**Upstream intent:** people, agents, workflows, and repositories use the same signed-event shape and search/audit substrate. Agents are members with keypairs and channel membership, not privileged global bot integrations. ([README](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L78-L85), [identity model](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L85-L96))

**Trade-off:** integration joins become simpler and more auditable, but every feature must be translated into durable event semantics. A single logical substrate does not make git blobs, audio frames, media, relational membership, and ephemeral presence physically identical; Buzz still needs specialized stores and projections.

### 7.2 Relay-authoritative, not federated gossip

**Source fact:** clients connect to one authoritative relay; no peer-to-peer event exchange, gossip, or replication is part of the core event model. ([architecture summary](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L3-L18))

**Trade-off:** this makes policy, search, audit, and operations easier to reason about than open federation, but availability and trust concentrate in the operator's relay deployment.

### 7.3 Community is a security label derived from the URL

**Source fact:** community identity comes from the host before AUTH/read/write handling. Tenant labels appear in DB keys, Redis keys, subscription indexes, caches, audit chains, and delivery gates. ([connection binding](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L50-L80), [subscription scope](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/subscription.rs#L70-L119))

**Trade-off:** the tenant boundary is explicit and testable, but it is cross-cutting. Every new durable row, cache, error, subscription, or external side effect must carry or re-establish the label.

### 7.4 Pure core, focused services, central orchestration

**Source fact:** `buzz-core` is I/O-free; service crates are focused; relay coordinates them. This favors local reasoning and testability without deploying each subsystem as a network service. ([core manifest](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-core/Cargo.toml#L1-L27), [dependency rule](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L75-L99))

**Trade-off:** fewer distributed-service boundaries and easier transactions, at the cost of a broad relay binary and a large composition root.

### 7.5 Standards compose; processes isolate

**Upstream intent and source-supported design:** ACP connects clients to agents, MCP connects agents to tools, and Nostr connects participants to the workspace. The project prefers protocol boundaries and independent subprocess lifecycles over internal runtime coupling. The broker contract sharpens this principle at the authority boundary: a keyless agent requests a named business operation, while requester identity, scope, secret-key custody, signing, and authorization remain with the authenticated host session. The request body cannot assert its own requester or owner. ([agent design principles](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION_AGENT.md#L21-L56), [broker authority rules](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L21-L44))

**Trade-off:** agents and tools are replaceable, and operation-level policy is possible without giving agents signing keys. The cost is a larger protocol surface: stdio/HTTP framing, cancellation, process-tree cleanup, timeouts, idempotency, response correlation, and protocol/action-version conformance become first-class reliability work. A raw-signing primitive would be smaller and more extensible, but would collapse policy to all-or-nothing authority; Buzz explicitly chooses the more reviewable closed operation set.

### 7.6 Bounded failure over invisible overload

Bounded buffers, semaphores, timeouts, TTL caches, fail-fast capacity checks, slow-client disconnects, and bounded output/history recur throughout the source. **Inference:** the system consistently prefers explicit degraded behavior or rejection over unbounded memory/process growth. This improves operational predictability but can surface user-visible drops/rejections during overload.

## 8. Implemented fact versus vision and documentation drift

The repository explicitly labels some features as shipped, in progress, or planned. Workflow approval suspension/resume remains incomplete; some workflow actions are still stubbed; mobile is in active development; remote-agent deployment is not presented as complete. The new broker code advances that direction only at the interface layer: its own module documentation says there is no host, transport implementation, signing, relay change, or Desktop integration yet. ([README status](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/README.md#L98-L109), [vision status](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L216-L236), [broker status boundary](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-sdk/src/broker/mod.rs#L1-L19))

Two concrete examples show why source should override prose at this fast-moving snapshot:

1. `ARCHITECTURE.md` still describes a bounded `search_index_tx` worker and lists it in `AppState`; current event source says that worker was removed because the Postgres generated `tsvector` is populated with the event row, and current `AppState` has no `search_index_tx`. ([stale architecture pipeline](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L221-L245), [current event source](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/handlers/event.rs#L490-L507), [current state](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L630-L760))
2. The limitations table says only a test rate limiter exists, while current source constructs a Redis-backed admission limiter and applies it to WebSocket/HTTP work. ([stale limitation](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/ARCHITECTURE.md#L816-L824), [current limiter state](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/state.rs#L720-L744), [current admission checks](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/crates/buzz-relay/src/connection.rs#L622-L711))

**Inference:** the architecture's direction is coherent, but exact operational claims should be pinned to a commit and checked in source, tests, and deployment configuration rather than taken from a single overview document.

## 9. Suitable and unsuitable scenarios

### A good fit

- A team wants a self-hosted workspace combining human discussion, agents, automation, project memory, and git activity.
- Auditability and identity-scoped agents matter more than integrating a privileged global bot.
- The team accepts a relay-authoritative model and can operate Postgres, Redis, and object storage.
- Developers want protocol-level agent/tool interchange through ACP and MCP.
- A product needs one event/search substrate across chat, workflows, and development artifacts.

### A poor fit, or requiring caution

- A lightweight chat bot or single-agent UI: Buzz's relay, data services, clients, and forge surface are much broader than needed.
- Fully decentralized, peer-to-peer, or federation-first social networking: the current architecture intentionally uses one authoritative relay/community boundary.
- Strict end-to-end encrypted collaboration where the server cannot inspect content: the vision delegates at-rest protection to storage and treats NIP-44 E2EE as future consideration. ([encryption position](https://github.com/block/buzz/blob/b622003f74aa5bf9b659786452813299a25e4897/VISION.md#L98-L102))
- Teams that require completed workflow approval resumption, finished mobile parity, or mature remote-agent deployment today.
- Environments unable to operate the required stateful dependencies or accept that post-commit side effects are not one atomic transaction.
- Compliance decisions based only on vision prose: some repository overview text currently lags implementation.

## Bottom line

Buzz's architecture is best understood as **a relay-centered, signed-event collaboration platform with first-class agent participation**. Nostr provides the common envelope and identity; Rust crate boundaries separate protocol, persistence, auth, pub/sub, search, audit, workflow, media, and agent concerns; the relay composes them into one authoritative workspace; Postgres/Redis/object storage divide durable, ephemeral, and blob state; ACP and MCP keep agent/tool runtimes replaceable.

The elegant part is the uniform boundary: a human, an agent, a workflow, and a repository action can share identity, history, search, and audit semantics. The difficult part is maintaining that uniformity without turning the relay into an unbounded god object or allowing tenant labels, kind policies, and post-commit failure semantics to drift. The current source shows active work on those boundaries, and also shows that the code is moving faster than some architecture prose.
