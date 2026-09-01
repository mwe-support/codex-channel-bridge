# Stage 8 release-candidate acceptance

- Date: 2026-09-01
- Candidate: Stage 8 working tree based on `2cffd29`
- Tested Codex CLI: `0.149.1`

## Native macOS and real QQ

- A per-user launchd deployment reached Supervisor `live` and Profile `ready`
  with the tested stable schema and the probed optional
  `thread/settings/update` capability.
- A real private QQ message from the signed-in native client completed one
  Codex Turn and displayed the exact `STAGE8-COMMANDS-READY` marker.
- `/status` and `/help` displayed their Bridge-owned replies. The first live
  `/status` exposed a missing QQ passive reply sequence; the shared command
  reply exit now uses the first reply sequence and the repeated command
  displayed `Profile ready; active=0; queued=0.`
- `/model` selected an entry discovered through native `model/list`, and
  `/reasoning` selected one of that model's native supported efforts. Both
  commands succeeded through `thread/settings/update`; no Bridge-side model or
  effort selection was persisted.
- `/new` detached the current Bridge-owned Binding. The next message initially
  exposed a detached-row uniqueness conflict. Rebinding now updates that row in
  place and preserves its Binding ID for existing correlation foreign keys. A
  repeated real message created a new native Thread and displayed the exact
  `STAGE8-NEW-THREAD-READY` marker.
- launchd stop completed the common bounded drain and exited successfully.

## Native Linux

- Target: `marvel-mini-pc`, Node.js 22.22.1, npm 10.9.4, administrator-supplied
  Codex CLI 0.149.1.
- Fresh dependency installation, 219 unit tests, 2 platform tests, the Codex
  protocol contract, 4 owner-only control-plane contracts, and the Supervisor
  process contract passed.
- A transient user-systemd service reached Supervisor `live` and Profile
  `ready`. Stop completed with `Result=success`, `ExecMainStatus=0`, and an
  inactive/dead final state.

## Linux Docker

- The production multi-stage image built with pinned Codex CLI 0.149.1.
- The container ran as `node`, published no ports, reported `healthy`, and
  reached Supervisor `live` with its Profile `ready`.
- Docker SIGTERM completed with exit code 0 and without an OOM condition.

## Remaining release boundaries

- No real WhatsApp account was paired, so Baileys provider acceptance remains
  unverified beyond deterministic adapter, authentication, lifecycle, media,
  and delivery tests.
- No native Windows host is designated; Windows service and named-pipe ACL
  acceptance remain unverified.
- `/attach` is covered by native-runtime and binding tests but was not exercised
  through the real QQ client in this run.

No credential, Secret Reference, raw provider identity, provider message ID,
Channel body, Codex output, reasoning, or sensitive local path is retained in
this evidence.
