# Native macOS QQ acceptance — stage 1

- Date: 2026-08-31 (Asia/Shanghai)
- Candidate: stage-1 working tree based on `a1b7006`
- Host target: native macOS
- Codex CLI: `0.149.1`, tested stable schema
- Channel: Tencent official QQ Bot, private conversation

## Content-free results

1. The direct QQ Adapter contract reached `ready`, observed one live inbound
   event, returned one correlated `accepted` outbound receipt, and the desktop
   client displayed the reply.
2. The complete Supervisor → Profile Worker → Codex App Server → durable
   Outbox → QQ process tree reached `ready`. Two separate UI submissions each
   produced one archive record, one terminal correlation, one Logical Result,
   and one accepted Outbox record; no pending delivery remained.
3. A 12-second active Turn accepted a second message through native steer. The
   two correlations became terminal while the Turn produced one Logical Result
   and one accepted Outbox delivery.
4. Killing the Profile-owned App Server child produced the observed transition
   `unavailable(protocol_fault) → ready` without stopping the Supervisor or QQ
   Adapter.
5. Applying a deliberately missing Codex executable kept the Profile
   unavailable while the QQ Adapter remained connected. The live input was
   archived, received the explicit unavailable response, created no Codex
   correlation, created no outage backlog, and left zero pending Outbox rows.
6. Restoring the administrator-supplied Codex executable returned the same
   Profile to `ready`; the next live input completed with a terminal correlation
   and accepted Outbox receipt.
7. SIGINT produced bounded `draining → stopped` Profile transitions and a final
   `supervisor_stopped` event.

The GUI harness submitted one unintended pre-existing local clipboard value
during preparation. It was a distinct provider event and normal Turn, was
interrupted through the native Bridge command, and is excluded from the passing
scenario counts. No credential, raw provider identity, provider message ID,
Channel body, Codex output, or local sensitive path is retained here.
