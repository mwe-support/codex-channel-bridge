# Logical Result and durable Outbox

## Ownership and commit order

Codex owns the Thread, Turn, items, and terminal status. The Bridge stores only
the Channel delivery projection needed after the terminal event. One
`commitCodexTurnResult` operation transitions the correlated Codex input to its
terminal state and creates the Logical Result plus every initial Outbox segment
in one immediate SQLite transaction. No Provider send happens before that
transaction commits. Recovery uncertainty uses the same pattern through
`commitCodexInputUncertainty`, so a correlation cannot produce both a terminal
reply and an uncertainty reply.

The identity `(Profile ID, Codex Thread ID, Codex Turn ID)` permits only one
Logical Result. A stable payload digest covers the destination and segment
content. Repeating the same terminal result returns the existing Logical Result
and Outbox identities; repeating the Turn with different content or destination
fails with `logical_result_conflict`.

## Outbox state machine

| State | Meaning |
| --- | --- |
| `pending` | Committed and ready for its first delivery attempt. |
| `leased` | Exclusively claimed by the current Profile delivery sweep. |
| `retry_wait` | Deferred or ambiguous and waiting for its persisted retry time. |
| `accepted` | The Provider returned a matching accepted receipt. |
| `rejected` | The Provider definitely rejected the segment, or an earlier segment of the same Logical Result was rejected. |

Segments of one Logical Result are leased in order. A later segment is not
eligible until every earlier segment is `accepted`. A definite rejection also
marks all still-unsent later segments rejected, preserving one terminal Channel
outcome instead of sending an incomplete tail.

Each lease has a random token and expiry. Settlement requires the current token,
so a stale worker cannot overwrite a newer attempt. An expired lease returns to
`retry_wait` with an `ambiguous` attempt outcome because a crash may have
happened before or after the Provider accepted the send.

## Profile-local delivery sweep

Each Profile owns one non-overlapping `DeliveryOutbox` sweep. The baseline
claims at most eight records, uses a 30-second lease, and schedules another
sweep after 500 milliseconds. It resolves an Adapter only when the configured
Provider, Channel Account, and Channel Account Epoch all match the persisted
record. A missing or stale Adapter binding is `deferred`; it is not represented
as a Provider rejection.

Accepted receipts must repeat the Logical Result ID and segment index from the
lease. A mismatched receipt or unexpected exception is `ambiguous`. Definite
Provider rejection is terminal. Deferred and ambiguous records retain the same
Logical Result and Outbox identity and use bounded exponential retry with
jitter; an Adapter-provided retry delay is treated as a minimum up to the
current one-hour cap.

Provider message IDs and delivery bodies remain in the Profile database only.
Operational logs and Channel status output must use internal references and
stable reason codes instead.

## Schema and current limits

New databases use Bridge schema version 6. Older databases fail closed with
Profile reason `migration_required`; normal service startup does not alter
them. The host-local [`migrations.md`](migrations.md) workflow explicitly
supports schema 3, 4, or 5 to 6 with snapshot evidence, full-plan confirmation,
transactional backfill/rebuild, verification, and body-free audit records.

The current Outbox provides durable generic delivery and crash-safe lease
recovery. For QQ passive delivery, the same transaction allocates and stores a
positive `msg_seq` for each `msg_id`; later Logical Results sharing that anchor
continue the sequence. Every ambiguous retry reuses that pair, and the QQ
Adapter uses the explicit raw-send path instead of allowing the SDK helper to
generate a new sequence.

This closes identity drift but not Provider reconciliation. If QQ accepted a
send whose response was lost, retrying the same pair can be rejected without a
lookup API that proves whether the original send became visible. A fallback
proactive send also has no documented idempotency identity. The project
therefore still discloses the ambiguous/duplicate window and does not claim
strict exactly-once QQ delivery.

Approval prompts are a third Logical Result source kind. The Approval Request,
prompt Logical Result, Outbox record, and body-free requested Audit Record are
committed atomically. Presentation settlement updates the Approval record in
the same Outbox transaction. Terminal callback, timeout, and App Server
generation loss reject any unsent Approval Outbox work so a stale token is not
presented after its native request disappears.

## Verification

The unit interface covers atomic commit and deduplication, conflicting replay,
ordered segments, durable reopen, lease expiry, stale settlement rejection,
ambiguous retry, definite rejection cascade, Adapter unavailability, receipt
correlation, and non-overlapping sweeps. Platform acceptance runs the same
suite on native macOS, native Linux, and Linux Docker.
