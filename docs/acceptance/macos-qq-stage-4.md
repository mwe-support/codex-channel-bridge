# Native macOS QQ acceptance — stage 4

- Date: 2026-08-31 (Asia/Shanghai)
- Candidate: stage-4 working tree based on `b0152c2`
- Host target: native macOS
- Codex CLI: `0.149.1`, tested stable schema
- Channel: Tencent official QQ Bot, private conversation restricted to one
  provider-stable identity

## Content-free results

1. The actual Supervisor, Profile worker, Profile-local Codex App Server, and
   official QQ adapter started from a fresh owner-only state directory. The
   Profile reached `ready`; capability negotiation classified Codex `0.149.1`
   as tested.
2. A real private message sent from the signed-in native QQ client completed one
   Codex Turn and displayed the exact expected terminal reply in that client.
   Schema version 8 then contained one Message Archive record, one Codex input
   correlation, one Logical Result, and one provider-accepted Outbox record.
3. The Supervisor completed a graceful `ready` to `draining` to `stopped`
   transition, then restarted from the same Profile state. The Profile returned
   to `ready`, and a second real private message displayed its exact expected
   terminal reply.
4. Final durable counts were two Message Archive records with two distinct
   provider event identifiers, two Codex input correlations, two Logical
   Results, and two provider-accepted Outbox records. No pending delivery or
   duplicate durable record remained. QQ deliveries correctly left the new
   WhatsApp-only quoted-reply columns empty.
5. Deterministic tests covered staged Baileys pairing, identity verification,
   revocation uncertainty, exact-confirmation local forgetting, lifecycle
   quiescence, body-free audit records, request-scoped QR event routing, and
   quoted-message reconstruction. No real WhatsApp account was paired during
   this QQ regression acceptance.

No credential, raw provider identity, provider message ID, Channel body, Codex
output, QR value, SDK authentication state, or sensitive local path is retained
in this record.
