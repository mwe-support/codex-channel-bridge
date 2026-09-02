# Stage 8 release-candidate acceptance

- Date: 2026-09-01
- Candidate baseline: `8686040` (`fix: complete WhatsApp live acceptance`)
- Release candidate: `v0.1.0-rc.1`; subsequent runtime refactor `d604739` was
  reaccepted through real macOS QQ before the release-only workflow and
  documentation changes
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
- After the architecture simplification, a real QQ-to-Codex round trip returned
  the exact `PONYTAIL-QQ-READY` marker on 2026-09-01. This reaccepted the
  runnable macOS QQ path at `d604739` without retaining message content or raw
  provider identifiers in the repository.

## Native macOS and real WhatsApp

- Owner-only host-local pairing activated a real Baileys Auth Generation and
  the Adapter reached `ready`; no pairing material was retained as evidence.
- A real private message completed one Codex Turn and provider-accepted Outbox
  delivery. The native client visibly received the reply, and a graceful
  restart reopened the active authentication without another QR.
- A real local `/status` command replied without creating Codex input. In the
  test group, non-selected `@` text remained passive; selecting the actual Momo
  member completed Archive, Codex correlation, Logical Result, accepted Outbox,
  and visible group reply.
- Acceptance fixed first-pair parent creation, Baileys 7 activation criteria,
  and group mention matching across the account's phone-number JID and LID.
  Temporary group access was restored to `deny` after the test.

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

## v0.1.0-rc.1 deterministic release gates

- On 2026-09-02, `release:check --tag=v0.1.0-rc.1` passed with all workspace,
  lockfile, documentation, changelog, and runtime version mirrors aligned.
- The local suite passed 219 unit tests, 2 release-tool tests, and 2 platform
  contract tests.
- The host macOS Codex protocol contract passed against Codex CLI `0.149.1`
  and schema SHA-256
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`.
- All 4 owner-only Unix control-plane contracts and the Supervisor worker
  process contract passed on the host macOS environment. Their sandbox-only
  `EPERM`/closed-stdout failures were not treated as host acceptance results.

## Remaining release boundaries

- No native Windows host is designated; Windows service and named-pipe ACL
  acceptance remain unverified.
- `/attach` is covered by native-runtime and binding tests but was not exercised
  through the real QQ client in this run.
- Real WhatsApp, native Linux, and Linux Docker acceptance above used the Stage
  8 baseline. Their exact `v0.1.0-rc.1` post-refactor revalidation is a release
  candidate follow-up and is not claimed by this record.

No credential, Secret Reference, raw provider identity, provider message ID,
Channel body, Codex output, reasoning, or sensitive local path is retained in
this evidence.
