# Current implementation comparison of three QQ ↔ Codex repositories

- Research date: 2026-08-28 (Asia/Shanghai)
- Fixed snapshots:
  - [`983033995/qq-codex-bridge`](https://github.com/983033995/qq-codex-bridge) at `ea6cfecc65e0530c45b6d5ae08cffe52dda74a4a`
  - [`gl813788-byte/codex-qq-bot`](https://github.com/gl813788-byte/codex-qq-bot) at `be09c76954e66ed10936fd3f114a565448bcd869`
  - [`uniqueFranky/Codex-QQBot`](https://github.com/uniqueFranky/Codex-QQBot) at `fb47a9f7c497fa2dbb743023934a431db42743be`

The comparison used source, manifests, deployment files and test configuration
from each pinned default branch. README claims were checked but were not treated
as implementation evidence. Here, reliable delivery means a persistent inbox or
outbox with state transitions, retry and restart reconciliation; a successful
HTTP call, in-memory deduplication or logging alone does not qualify.

## Executive conclusion

These repositories follow three different designs:

1. **`qq-codex-bridge` has the clearest Bridge-shaped architecture.** It uses
   Tencent's official Bot Gateway/API, layered channel/domain/orchestrator/store
   modules, SQLite conversation bindings and a long-lived App Server client.
   However, its App Server handshake omits `initialized`, every server-initiated
   request receives `-32601`, and `delivery_jobs` has no retry or completion
   state machine. It is a structured prototype, not a complete reliable Bridge.
2. **`codex-qq-bot` has the broadest QQ product and native Codex control surface.**
   It uses OneBot/NapCat, starts `codex app-server --stdio` per task, and supports
   resume, steer, interruption/replacement, scoped sessions, roles, memory and
   dynamic tools. Normal QQ Turns do not install its approval UI hook, inbound
   deduplication is in memory, and there is no transactional outbox. It is closer
   to a local QQ Agent Hub than a narrow official-Bot Bridge.
3. **`Codex-QQBot` is the smallest Docker wrapper, but not an App Server Bridge.**
   It manually implements Tencent C2C messaging and runs `codex exec --json` or
   `codex exec resume`. All users share one current Thread and one queue; there
   is no OpenID ACL, durable deduplication or outbox. Docker defaults to
   `danger-full-access` and installs the then-current Codex version at build time.

None implements the complete chain of durable inbound deduplication, Codex input
correlation, transactional logical result plus outbox, provider receipt/retry,
restart reconciliation, and response to the original native approval request.

## Snapshot

| Repository | Branch / version | Last commit | License observed |
| --- | --- | --- | --- |
| `qq-codex-bridge` | `main` / `0.1.4` | 2026-04-26 | MIT |
| `codex-qq-bot` | `main` / `1.1.9` | 2026-08-26 | No root or manifest license found in this snapshot |
| `Codex-QQBot` | `master` / `0.1.0` | 2026-05-11 | MIT |

Repositories can change after these commits. No missing license or capability
claim below should be generalized beyond the pinned snapshot.

## Comparison matrix

| Dimension | `qq-codex-bridge` | `codex-qq-bot` | `Codex-QQBot` |
| --- | --- | --- | --- |
| QQ transport | Official Tencent Gateway/API; C2C and group; multiple Bots | OneBot HTTP webhook/API, normally NapCat/LLBot; private and group | Official Tencent Gateway/API; C2C handling only |
| Codex transport | Long-lived App Server WebSocket by default; Desktop fallback | One `app-server --stdio` process per task | `codex exec --json` per task |
| Session mapping | SQLite account/chat/peer → Thread | JSON scope → Thread, with temporary/persistent/auto modes | One global Thread plus named aliases |
| Concurrency | Per-session serialization; App Server sessions can run concurrently | Global bounded limiter and per-scope follow-up coordination | One active run and one global FIFO |
| Approvals | All server requests rejected as unimplemented | Extensible dispatcher, but normal QQ Turns use default declines | Not available through `codex exec` |
| Inbound dedupe | SQLite provider message ID plus short in-memory fingerprint | Ten-minute bounded in-memory map | None |
| Durable outbox | Table shape only; pending insert without worker/state updates | None; post-send receipt classification only | None |

## `983033995/qq-codex-bridge`

The repository separates applications, adapters, domain, orchestrator, ports and
store. Its QQ adapter manually implements token acquisition, Gateway discovery,
heartbeat, identify/resume, C2C/group dispatch and REST sends. C2C sessions key
on user OpenID; a group shares one Codex session while retaining member OpenIDs.
Multiple Bot accounts have separate Gateway state but share one SQLite database
and one Codex driver.

The default driver starts a long-lived `codex app-server` WebSocket process and
uses `thread/start`, `thread/resume`, `turn/start`, delta/item notifications and
`turn/completed`. It sends `initialize` but does not send the protocol's
`initialized` notification. Normal follow-up does not use `turn/steer`; only a
stale in-progress Turn is interrupted before starting another. A new Bridge
session without a binding first selects App Server's latest Thread, so separate
QQ sessions can initially bind the same Thread.

SQLite persists session bindings and provider message IDs. The apparent database
session lock is not a cross-process lease because old rows are deleted before a
new owner is inserted. `delivery_jobs` receives only a pending insert; there is
no completion update, retry worker, provider receipt or startup reconciliation.
Gateway sequence state is saved before business commit, leaving a possible crash
window between resume progress and durable inbound recording. No Channel ACL or
Channel approval transport was found. CI and a meaningful test suite provide an
engineering baseline, but not production acceptance.

## `gl813788-byte/codex-qq-bot`

This project is a broader Hub with a large transitional composition root plus
focused modules for OneBot, dashboard, social actions, memory, files and tools.
It is not Tencent's official Bot route. Each Codex task starts a fresh stdio App
Server, performs `initialize` plus `initialized`, resumes or creates a Thread,
starts a Turn, and terminates the child at completion. Active work supports
native steer and interrupt/replacement with generation-aware follow-up handling.

Sessions are persisted by QQ scope with temporary, persistent and automatic
modes. The JSON writer coalesces changes and uses temporary-file, fsync and rename
steps. Global Codex and webhook concurrency limiters are bounded, and per-scope
scheduling protects the active generation. The Hub has owner/admin/group/command
policies and restricts child environment variables.

The App Server request dispatcher is extensible, but normal QQ reply/file paths
do not provide the handler: command/file approval defaults to decline, user input
returns empty answers, and MCP elicitation declines. OneBot deduplication is lost
on restart. Delivery receipts distinguish delivered and failed bubbles and feed
failure context to later work, but there is no pre-send durable transaction or
automatic retry queue. In the research environment 439 of 449 Node tests passed;
the ten failures involved sandbox writes/listeners, macOS path aliases and
installer environment behavior. The snapshot had no discoverable license, so
its source cannot be assumed reusable.

## `uniqueFranky/Codex-QQBot`

This small application manually implements Tencent token, Gateway and C2C send
flows, but ignores group dispatch. Each task starts `codex exec --json`, optionally
with `resume`, and parses Thread-started and agent-message events. `/interrupt`
kills the process; it is not native Turn steering.

One JSON state holds `threadId`, `messageQueue` and `lastOpenid`. Queue entries do
not retain their sender, so concurrent users can share context and receive replies
through the wrong conversation. No OpenID ACL protects commands such as process
start/stop, memory, session and model management. State uses direct synchronous
writes without atomic replacement or locking. There is no inbound ledger,
outbox, retry or persistent provider receipt. The Docker image runs Codex with
approval bypass and `danger-full-access`, as root, against mounted directories.
Its build queries and installs the latest Codex version, making builds of one Git
commit time-dependent. No tests or CI were found, and the README warns users to
review the AI-generated project.

## Implications for this Bridge

Useful patterns to study are:

- the first repository's channel port, official QQ session key, Gateway lifecycle
  and long-lived App Server boundary;
- the second repository's stdio JSONL parser, correct handshake, native steer and
  replacement, bounded limiter, atomic JSON persistence and delivery receipts;
- the third repository's minimal official QQ token/Gateway/C2C sequence and
  narrow Docker workspace mount example.

Do not directly adopt the first repository's incomplete outbox or `-32601`
request handling, the second repository's OneBot/NapCat runtime or unlicensed
source, or the third repository's global Thread/queue, missing ACL, `codex exec`
transport and build-time-latest Codex installation.

All three lack the Profile/Channel Account/Epoch binding, cross-Profile isolation,
durable input/result correlation, ambiguous-delivery model, approval-to-original-
request binding, capability probes, circuit breaker and bounded drain required by
this project's contracts.

## Verification limits

The review cloned and pinned all three default branches; inspected manifests,
QQ ingress/egress, Codex clients, state, concurrency, authorization and deployment
files; searched globally for delivery, retry, approval, steer, identity and dedupe
paths; ran the second repository's Node suite; and checked licenses, workflows,
tags and commit metadata. It did not use real QQ credentials, start a real App
Server, run target-platform lifecycle tests, inject crash/send faults, or obtain
license permission outside GitHub. The findings support source-level architecture
comparison, not production acceptance.
