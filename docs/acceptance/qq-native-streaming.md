# QQ native streaming — Next working-tree verification

Date: 2026-09-04. Status: primary real-provider path passed; boundary acceptance pending. No commit or release
tag is assigned to this fix. Existing unrelated working-tree changes are retained.

## Verified locally

- `npm run build`, all 236 unit tests, bilingual `npm run docs:build`, and
  `git diff --check` passed on the final candidate.
- Regression reproduced before the fix: `codex-event-router.test` observed no
  answer update before terminal completion. It now receives only matching
  `final_answer` item deltas; stale Turns and commentary are excluded.
- Unit tests cover the exact QQ payload (one anchor, stable sequence/identity,
  increasing index, generation/DONE states), group rejection, coalescing,
  persistent sequence reservation, uncertain-send recovery, prefix-conflict
  fallback, DONE deduplication, Unicode-preserving segmentation and schema migration.
- `npm run test:contract` passed on native macOS with administrator-provided
  Codex 0.149.1 and stable schema SHA-256
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`.
  The sandbox attempt exited before initialization; the host rerun passed.
- A real Codex Turn, with tools prohibited by its test prompt, emitted 293 answer
  deltas and 293 routed updates before normal completion; final text length was
  1,663 characters. Only counts, phase and status were retained, not answer text.
- Release-tool tests: 4/4. Platform file-contract tests: 4/4. These are not
  Linux, Docker or Windows execution evidence for this change.

## Deployment and real QQ evidence

The test Profile was bounded-drained and a local snapshot of state, Codex home,
Workspace and external credentials was verified: 2,656 files, 84,493,413 bytes.
A fresh stopped-state snapshot matched the migration source digest after the
backup-finish audit entry. After the requested post-snapshot operator confirmation,
the supported explicit migration applied schema 9→10 successfully. The restarted
Supervisor reports QQ and WhatsApp ready. The independent Dashboard stayed running.

The initial real private-chat attempt accepted one generation frame but then
fell back to an ordinary complete answer. The local guard incorrectly treated
`remain_msg_len=0` as exhausted writable capacity. A regression test returning
zero for each accepted frame failed before guard removal and passed afterwards.
The corrected build was deployed by bounded Supervisor restart before retesting.

| Real macOS QQ client scenario | Content-free result |
| --- | --- |
| Private long answer | While Codex was still `started`, 7 accepted frames held 281 characters; later 23 held 997. The same client message visibly grew from a partial second paragraph into the ninth. Final: 44 frames including accepted DONE, 1,862 characters, `completed`. |
| Final-delivery correlation | One accepted Outbox segment, attempt count 1; its provider receipt ID equals the persisted native stream ID. No ordinary second final reply was observed. |
| Private short answer | 2 frames including DONE, 11 characters, accepted Outbox attempt 1, same native receipt ID. A second 8-character short reply also passed. |
| Group complete answer | Real member-picker mention of the configured test Bot; 1,366-character complete reply, accepted Outbox attempt 1, no answer-stream record. |

The provider returned zero remaining length while accepting continued frames and
DONE. The implementation therefore records this field but does not use it as an
admission budget; its undocumented exact meaning is not asserted. Thinking or tool
execution without a `final_answer` delta still has no answer text to stream.

Still required: long-duration expiry/rate/connection boundaries, interruption/
restart recovery, and overlapping private/group isolation with streaming active.
The attempted group/private overlap ended too soon to establish simultaneous active
Turns; it proves two successful routes, not concurrent acceptance. WhatsApp is
connected, but no new WhatsApp client interaction was performed for this fix.
Mocked boundary tests do not replace these outstanding real-provider checks.
