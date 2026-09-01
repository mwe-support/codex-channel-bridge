# Stage 8 macOS WhatsApp acceptance

- Date: 2026-09-01
- Candidate: `1bc2e0e` plus the WhatsApp pairing fixes recorded by this acceptance
- Host: native macOS
- Codex CLI: administrator-supplied `0.149.1`
- Provider library: `baileys@7.0.0-rc14`

## Real account result

- Pairing was initiated only through the owner-only local control socket and an
  interactive host terminal. The QR value was not persisted or copied into the
  repository, logs, audit records, or this evidence.
- The phone confirmed the linked device, the Bridge atomically created the
  active Auth Generation, and the WhatsApp Adapter transitioned to `ready`.
- A real private inbound message from the native WhatsApp client produced one
  archived event, one Codex input correlation, one Logical Result, and one
  provider-accepted Outbox delivery. The client visibly received the reply.
- After a graceful Supervisor stop and restart, the active Auth Generation was
  reopened without another QR and the Profile returned directly to `ready`.
- A real post-restart local Bridge command was received and replied to without
  creating another Codex input correlation, preserving the command ownership
  boundary.
- In the test group, ordinary text that looked like an `@` mention but did not
  select the provider member was archived passively and created no Codex input.
- After selecting the actual Momo member, the real group message added one
  Archive record, Codex input correlation, Logical Result, and provider-accepted
  Outbox delivery. The native client visibly received Momo's group reply.
- Group access was opened only for this acceptance and restored to `deny` after
  the bounded test.

## Defects found and fixed

1. The production Profile path is `state/channel-auth/ACCOUNT`, but first-pair
   creation assumed the `channel-auth` parent already existed. The Auth-state
   module now creates and validates that owner-only parent before creating the
   Account root. A nested-path regression test covers the production shape.
2. Baileys 7 QR pairing persists `creds.me` and the signed `account`, while its
   legacy `creds.registered` field remains false on this path. The Bridge now
   activates a staged Generation from the actual pinned-library credential
   contract. Regression tests keep `registered=false` while proving successful
   activation, restart-required handling, and Account lifecycle replacement.
3. Content-free `WhatsApp pairing ...` failures were previously collapsed into
   a generic IPC error. The initiating local CLI now receives that bounded safe
   stage message while raw QR and Provider Identity remain excluded.
4. Baileys 7 represents a selected group mention with the account's LID, while
   the Adapter compared only `socket.user.id`. The normalizer now accepts both
   `id` and `lid`; a regression test covers a LID mention without weakening the
   passive-message boundary.

Two provider-linked devices created during failed pre-fix attempts were removed
by the account owner. Their staged local Generations were discarded and never
became active.

This evidence contains no Channel body, Codex output, raw Provider Identity,
provider message ID, QR value, credential, auth state, or sensitive local path.
