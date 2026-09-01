# Native macOS QQ acceptance — stage 6

- Date: 2026-09-01 (Asia/Shanghai)
- Candidate: stage-6 working tree based on `e9cfcab`
- Host target: native macOS
- Codex CLI: `0.149.1`, tested stable schema
- Channel: Tencent official QQ Bot, private conversation restricted to one
  provider-stable identity

## Content-free results

1. The actual Supervisor, Profile worker, Profile-local Codex App Server, and
   official QQ adapter reached `ready`. The signed-in native QQ client sent one
   real private message. The Bridge completed one Codex Turn and the client
   displayed the exact `STAGE6-OPERATIONS-READY` marker.
2. `bridge doctor` inspected the live Profile without changing it. It reported
   `ready`, no issues, SQLite `quick_check=ok`, schema version 9, and sufficient
   available disk capacity.
3. `backup prepare` completed the bounded drain and durable maintenance hold.
   The Profile transitioned through `ready` to `draining`, `stopped`, and
   `stopped: maintenance_hold`. An actual owner-only external snapshot copied
   the Bridge state and Codex home; the transient Codex IPC socket was excluded
   because Unix sockets are not persistent backup data.
4. Read-only `restore validate` returned `valid=true` with no issues while the
   matching hold existed. `backup finish` accepted snapshot confirmation and
   the exact hold token, after which the same Profile returned through
   `starting` to `ready`.
5. The Support Bundle plan/apply CLI exposed one bug during acceptance: its
   confirmation digest included the plan expiry, so a repeated confirmation
   command could not match. The digest now covers only the stable selected
   scope and output contract; a focused regression assertion and the real
   two-command CLI workflow both passed.
6. The created Support Bundle contained three owner-only `0600` files. A
   content scan found no complete local path, Secret or credential term,
   Channel body, Codex input/output/reasoning field, or raw provider identity.
   Audit query returned only body-free `backup_prepare`, `backup_finish`, and
   `support_bundle_create` actions.
7. Manual circuit reset against a healthy Profile failed closed with
   `circuit_not_open`. Unit coverage verifies that an actually open circuit is
   released only through the exact Profile-local reset path and must repeat
   capability negotiation.
8. The post-run database remained schema version 9 with `quick_check=ok`.
   Durable totals were seven Message Archive rows, one attachment, one Thread
   Binding, six Codex input correlations, six Logical Results, six Outbox
   records, zero pending Approval Requests, and three body-free Audit Records.
9. The Supervisor completed a final graceful `ready` to `draining` to
   `stopped` transition. The temporary external snapshot and Support Bundle
   were deleted after validation so no copied credential or Codex-home material
   remained under the test directory; original Profile data was preserved.
10. The complete deterministic suite passed 217 of 217 tests. Native host
    contracts also passed against Codex `0.149.1`: generated-schema protocol,
    all four owner-only control-plane socket cases, and the Supervisor
    worker-process contract.

No credential, Secret Reference name, raw provider identity, provider message
ID, Channel body, Codex output, media content, or sensitive local path is
retained in this record. No real WhatsApp account was paired.
