# Native macOS QQ acceptance — stage 5

- Date: 2026-08-31 (Asia/Shanghai)
- Candidate: stage-5 working tree based on `80bbfa3`
- Host target: native macOS
- Codex CLI: `0.149.1`, tested stable schema
- Channel: Tencent official QQ Bot, private conversation restricted to one
  provider-stable identity

## Content-free results

1. Starting the actual Supervisor against the prior schema version 8 state
   failed the Profile closed with `migration_required`. An explicit 8 to 9
   migration plan was confirmed only after an owner-only SQLite snapshot and
   matching snapshot manifest existed. Migration completed independently for
   the Profile; normal service start did not perform it.
2. The actual Supervisor, Profile worker, Profile-local Codex App Server, and
   official QQ adapter then reached `ready`. A real private message from the
   signed-in native QQ client completed one Codex Turn and displayed the exact
   expected stage marker. After a graceful `ready` to `draining` to `stopped`
   transition and restart from the same state, a second real private message
   displayed its distinct expected restart marker.
3. The Profile-local Archive MCP ran over stdio and exposed exactly the
   read-only `archive_search` and `archive_recent` tools. A live bounded query
   returned archived results without provider event identifiers or provider
   identities. It did not mutate the Profile or Codex configuration.
4. The host-local Archive Purge plan reported the exact whole-Profile message
   count, zero live references, referenced media bytes, and the required
   confirmation fields. No destructive purge was applied to the live
   acceptance Profile.
5. The signed-in QQ client sent the repository's public Apache-2.0 `LICENSE`
   file to the test Bot. QQ visibly confirmed the send. The Bridge committed
   one additional Message Archive row and one attachment row with state
   `metadata_only`, mirrored zero bytes, and did not start a Codex Turn from the
   attachment-only event. This confirms the current official QQ contract is
   metadata/link persistence rather than byte mirroring.
6. At that checkpoint, schema version was 9. Durable counts were five Message Archive rows,
   one metadata-only attachment, four Codex input correlations, four Logical
   Results, four provider-accepted Outbox records, and zero pending deliveries.
   The Supervisor again completed a graceful drain and stop.
7. The complete deterministic suite passed 204 of 204 tests, including local
   Hybrid Retrieval, read-only Archive MCP projection, transactional attachment
   metadata, serialized Profile media quota accounting, Archive Purge, Profile
   Purge tombstones, schema migration, QQ metadata mapping, and Baileys
   decrypted-stream handling. No real WhatsApp account was paired.
8. Native host contracts passed against Codex `0.149.1`: the generated-schema
   protocol contract, all four owner-only control-plane socket cases, and the
   Supervisor worker-process contract all exited successfully.
9. After the final media-path, restart-reconciliation, purge-state, and
   configuration-boundary hardening changes, the actual current working tree
   was deployed again. The Profile reached `ready`; one additional real QQ
   private message displayed its exact final marker, and shutdown again passed
   through `draining` and `stopped`. The post-hardening durable totals were six
   Archive rows, one metadata-only attachment, five correlations, five Logical
   Results, five accepted Outbox records, and zero pending deliveries.

No credential, raw provider identity, provider message ID, Channel body, Codex
output, attachment contents, SDK authentication state, or sensitive local path
is retained in this record.
