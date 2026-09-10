# Mainline boundary acceptance — 2026-09-09

Follow-up: [2026-09-10 QQ acceptance](qq-late-delivery-20260910.md) closes the
proactive-permission block and adds real same-account private-stream/group
interruption evidence. The observations below retain their original date.

Scope: native macOS, native Linux and Linux Docker, continuing
[mainline acceptance](mainline-20260909.md). Windows remains separate on
`codex/windows-unattended`. This batch closes the scenarios below, but does not
close every provider boundary or publish a release.

## Candidate and checks

The final runtime snapshot is
[`9ea63a0b4340d91016c292b5ce6996047c362bf1`](https://github.com/mwe-support/codex-channel-bridge/commit/9ea63a0b4340d91016c292b5ce6996047c362bf1).
All three runtimes use persistent, fixed source snapshots. The final Docker
image is `sha256:82774d18f15bf459808bdc2cf2fc23ce3cf6d31663c901e0bea6b6647e683efe`.
Host Codex installations were unchanged; the actual executable version was
0.153.4. Schema 11 was unchanged. Version/schema observations are evidence,
not a compatibility allowlist.

- All three environments passed 263 unit tests, with one Windows-only skip.
  The Docker test subprocess explicitly removed the live deployment's
  `BRIDGE_CONFIG_OVERRIDES_JSON`: an earlier test run inherited that override
  and failed an isolated configuration fixture. The running service environment
  was not changed.
- macOS passed four release-tool checks and four platform checks, with three
  Windows-only platform skips. The final release fixture also passed the full
  check command, five control-plane contracts, native Supervisor contract and
  bilingual documentation build.
- After relocating the Mac runtime, native `thread/read` returned a canonical
  Workspace while configuration retained its directory alias. The final fix
  shares directory-identity validation between Thread model administration and
  Channel attach. Real Thread-scoped model query now succeeds; regression
  rejects other, missing and relative directories. No native path/history or
  model selection was rewritten.

## Same-account WhatsApp interruption

For each environment, a real private and group conversation on the same
WhatsApp Channel Account used distinct native Threads. Both were started before
the private `/stop`; immediately afterward the private Turn was interrupted
while the group remained started. The group subsequently completed, its exact
reply appeared in the recipient client, and both terminal deliveries received
first-attempt provider acceptance and receipts.

| Runtime | Group completion after private interruption |
| --- | ---: |
| Native macOS | 602,276 ms |
| Native Linux | 595,096 ms |
| Linux Docker | 206,886 ms |

The successful Docker run included native execution approvals in both
conversations before interruption. An earlier Docker run whose group approval
expired, and earlier tests whose group completed before interruption, are
excluded. This proves independent interruption and final delivery; it does not
add visual typing-indicator/cleanup evidence by itself.

## Mac WhatsApp waiting indication

Separate private/group tests used foreground tool-only waits. The actual Mac
client displayed the native typing bubble immediately after each sent request,
and it remained visible at later observations approximately 85 seconds (private)
and 49 seconds (group) later. No answer text was sent during these waits. Each
bubble disappeared after the complete final reply was received. A further
private test displayed typing, accepted `/stop`, then cleared the bubble and
received the interruption notice. All three terminal Outbox deliveries were
accepted on attempt one with provider receipts.

Together with the existing presence lifecycle/failed-send regression and real
QQ shared-path checks, these observations close FR-001's recorded Mac visual
acceptance. The same-account interruption evidence above closes FR-003's
outstanding scenario. Both requirements are now `done` for their recorded
feature scope; this does not rewrite immutable release evidence or promise the
same visual presentation in every WhatsApp client.

## QQ group attachments

The target-host test Bot joined the existing test group. A fresh denied route
message was observed before allowing only that group and participant through
canonical CLI configuration and explicit apply. No chat history was shared at
join. Both native Linux and Docker then returned existing harmless Workspace
files through real QQ group Turns. File sends had accepted Outbox records and
provider receipts. Actual QQ Save As downloads matched their source, immutable
Bridge snapshot and Outbox digest.

| Runtime | Bytes | SHA-256 |
| --- | ---: | --- |
| Native Linux | 18 | `e1234433293dcd539e042f4c6ffe7cc5e31d7b72e94d4428430ca76401a23cce` |
| Linux Docker | 19 | `cb3769da29387c55bd9ca3b5041be26948d7976082701abc81952aba9bc06c9b` |

## Real process loss and uncertain delivery

The first Mac App Server crash exposed a defect: recovery notification used
the serialized Archive dedupe key as its provider reply anchor. Its rejected
notification remains historical evidence. The shared store fix at
[`fc7bf4c01ea7c14fb2bf7bc0fc4564a4155f97bf`](https://github.com/mwe-support/codex-channel-bridge/commit/fc7bf4c01ea7c14fb2bf7bc0fc4564a4155f97bf)
recovers the original QQ/WhatsApp wire message ID and preserves QQ reply
sequence allocation. Provider/conversation variants and legacy keys are covered
by regression tests; no schema migration was introduced.

The corrected Mac test killed the actual Profile App Server after one accepted
native frame (21-character durable prefix). The same Supervisor observed a new
App Server. The original input became `uncertain` with
`turn_result_uncertain`; it was not replayed. Its uncertainty notification was
accepted on attempt one, at reply sequence 2, and appeared in QQ. A deliberate
new request completed on the same Thread and reached the client.

Native Linux then killed the actual Profile worker while its QQ stream state
was `sending`, after an earlier accepted frame with a one-character durable
prefix. The client had already displayed text beyond that prefix: this exercises
a real provider-accepted frame whose acknowledgement was not durably recorded.
The Supervisor stayed live, the Profile reported `worker_process_exit`, and all
old App Server descendants exited. Automatic worker restart was observed;
explicit Supervisor stop/start was also checked. Reconciliation retained one
original input, marked `turn_result_uncommitted`, and did not replay it. The
uncertainty notification was accepted at sequence 2 and visible in QQ. Native
Thread model/effort remained equal, and a deliberate continuation succeeded.

These tests prove uncertainty handling, notification and continued use. They do
not claim reconstruction of a lost full answer, a received DONE frame for the
crashed stream, or elimination of the provider duplicate window.

## QQ expiry and quota observations

A real group Turn completed after 369,007 ms, but its final Outbox record was
rejected without a receipt. A subsequent real REST probe through the production
adapter and pinned Tencent SDK reproduced HTTP 400 / business code `40034005`
for the original passive anchor. The adapter then attempted proactive delivery,
which returned HTTP 400 / `40034105`; the actual provider message confirmed
permission denial. This is observed expiry and fallback-attempt evidence, **not
successful late delivery**. The Mac QQ client did not expose the needed bot
permission control; enabling it in the target group and rerunning late delivery
remain pending.

Separate private-chat probes accepted approximately six-hour-old and
28-hour-old anchors, including stream starts. They do not establish an unlimited
window. A bounded probe of 21 proactive private messages at one-second intervals
was accepted throughout; no real rate-limit rejection was observed. These REST
probes used the actual production adapter/SDK with a minimal ready facade and
did not exercise a second Gateway connection. Deterministic rate-limit/fault
contracts remain separate evidence.

## Backup, rollback and release assembly

Before replacing the live Mac runtime, public backup prepare held the Profile,
and an operator snapshot copied opaque state, Codex home, Workspace and external
secret material. Source/copy/source verification matched 8,097 files and
155,697,920 bytes. Restore validation and explicit backup finish passed.

Isolated rollback fixtures passed on macOS, native Linux and Docker. Each used
the exact immutable `v0.2.0-rc.1` code as the old binary, an independent Profile
without Channel credentials, the same absolute paths and native Codex 0.153.4.
Each exercised old-version readiness, backup hold/snapshot, candidate readiness,
old-binary schema-11 compatibility with two Archive records, restoration of all
three opaque data domains, validation/finish, old-version readiness with the
original one record and Workspace sentinel, then exit-zero stop. Candidate data
was retained separately; there was no down migration or Codex history rewrite.

The Mac rollback candidate was `fc7bf4c` in an isolated version fixture;
Linux/Docker used `9ea63a0`. The later Workspace identity fix does not change
storage format. Docker exercised old/new compiled Bridge binaries inside the
current container's Node/Codex/CA environment; it does not establish rollback of
the complete original image configuration.

An independent local clone rehearsed version preparation, bilingual changelogs,
annotated tag/HEAD alignment, source archive layout and checksum verification.
Its final fixture label was `0.2.0-rc.3`; the earlier fixture tag was preserved.
The 850,248-byte archive SHA-256 is
`2ea5fc56d2c69f28ac0c379c8d7356d90641f4d7841edd8bfa65fe467962cd20`,
also verified after transfer to Linux. These tags/artifacts exist only in the
rehearsal clone. The project version and published tags were not changed;
no GitHub Release was created. Exact final release-tag acceptance still belongs
to the eventual authorized release.

## Retained limits and operational state

- Successful QQ group late delivery awaits proactive permission and retest.
  Real C2C expiry/rate-limit rejection and other unobserved cases in
  [stream acceptance](qq-native-streaming.md) retain their gates.
- Mac WhatsApp typing visibility/cleanup was observed separately as described
  above; other clients and provider failure presentations are not inferred.
- Windows acceptance and actual release publication remain separate.
- The stale legacy Mac WhatsApp adapter was reversibly disabled through CLI
  configuration apply. Its authentication, Archive and bindings were preserved;
  this is not provider logout or successful reauthentication. The current QQ
  and replacement WhatsApp adapters report ready.
- Final read-only checks found zero active inputs and zero pending Outbox
  deliveries on both test Profiles; SQLite `quick_check` returned `ok`.
  Historical uncertain inputs and rejected deliveries were preserved. The Mac
  runtime remains ready. Docker subsequently drained and exited zero; its test
  container was removed, while configuration, credentials, history, fixed runtime
  and startup scripts were retained. Native Linux and Docker are both stopped.

Raw identities, Channel/model bodies, authentication and full private paths are
excluded from this record. Operator-local evidence retains the correlated
checks; provider success and failed attempts are not merged into one result.
