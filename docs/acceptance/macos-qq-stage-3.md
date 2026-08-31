# Native macOS QQ acceptance — stage 3

- Date: 2026-08-31 (Asia/Shanghai)
- Candidate: stage-3 working tree based on `aee8989`
- Host target: native macOS
- Codex CLI: `0.149.1`, tested stable schema
- Channel: Tencent official QQ Bot, private and group conversations

## Content-free results

1. The Profile schema migrated to version 7 and persisted one session-aware,
   Profile-local QQ Gateway transport checkpoint for the bound Channel Account.
   A fresh private message completed one Codex Turn and one provider-accepted
   Outbox delivery before the durable checkpoint advanced.
2. A real long-running Turn accepted a second private message through native
   `turn/steer`. The final Channel delivery was one Logical Result and one
   accepted Outbox record rather than two competing terminal replies.
3. The Supervisor completed a graceful stop and restarted from the same Profile
   state. The official SDK resumed from the durable checkpoint; no Message
   Archive, Codex input correlation, Logical Result, or Outbox record was
   duplicated. A new post-resume private message then completed normally.
4. A real group message without an active bot mention was archived but did not
   create Codex work or an outbound reply, preserving the passive group policy.
5. Real QQ client selection of the bot through the group `@` picker exposed a
   provider boundary: QQ delivered `GROUP_MESSAGE_CREATE` with
   `mentions[].is_you=true`, not only `GROUP_AT_MESSAGE_CREATE`. The adapter was
   corrected to recognize both official SDK representations, and the repeated
   real group mention completed one Codex Turn and displayed the expected reply.
6. Deterministic contract tests covered out-of-order concurrent completion,
   archive-commit failure, durable invalid-session clearing, restart restore,
   HTTP 429 deferral, and ambiguous provider send outcomes. These are injected
   fault tests; no claim is made that Tencent produced a real rate-limit or
   ambiguous-send failure during this acceptance run.
7. Final durable counts were seven Message Archive records, five Codex input
   correlations, four Logical Results, four provider-accepted Outbox records,
   and one QQ transport checkpoint at sequence 10.

No credential, raw provider identity, provider message ID, Channel body, Codex
output, SDK session identifier, or sensitive local path is retained in this
record.
