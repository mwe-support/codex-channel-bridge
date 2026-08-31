# Native macOS QQ acceptance — stage 2

- Date: 2026-08-31 (Asia/Shanghai)
- Candidate: stage-2 working tree based on `ad53710`
- Host target: native macOS
- Codex CLI: `0.149.1`, tested stable schema
- Channel: Tencent official QQ Bot, private conversation

## Content-free results

1. The App Server child environment excluded the enclosing Codex Desktop tool
   pipe, permission profile, Session identifiers, Channel credentials, and
   deployment-wide API keys while preserving the Profile Codex home and the
   native `on-request` plus `workspace-write` settings.
2. The host Codex configuration uses native `auto_review`, which resolves
   approvals inside Codex and correctly produces no unresolved Channel prompt.
   To exercise the unresolved transport, an administrator-supplied temporary
   executable wrapper selected Codex's native `user` reviewer without modifying
   the host configuration or adding a Bridge-owned Reviewer policy.
3. A real outside-workspace command request created one durable Approval
   record, one Approval Logical Result, and one provider-accepted Approval
   Outbox record before the QQ client displayed the decision prompt.
4. An intentionally invalid token left the Approval pending. The correct token
   responded only to the original App Server request; the record became
   `responded/accepted/accept`, the command completed, and one terminal Codex
   Logical Result reached provider-accepted Outbox delivery.
5. A second pending Approval was interrupted by terminating only the
   Profile-owned App Server child. The Profile transitioned
   `unavailable(protocol_fault) → ready`; the Approval became `cancelled` with
   reason `app_server_generation_lost`, and restart reconciliation committed
   one uncertainty result. Reusing the old token after restart changed no state
   and performed no command work.
6. Final durable counts were two Approval requests, two accepted Approval
   presentations, one responded decision, one generation-lost cancellation,
   three accepted Outbox records, one rejected stale-generation record, and
   four body-free Approval Audit Records for request/presentation/resolution.
7. The fresh acceptance deployment archived five real inbound events. SIGINT
   ended with bounded `draining → stopped` and `supervisor_stopped` transitions.

No credential, Approval token, raw provider identity, provider message ID,
Channel body, Codex output, or sensitive local path is retained in this record.
