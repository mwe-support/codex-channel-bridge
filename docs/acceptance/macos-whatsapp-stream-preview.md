---
title: macOS WhatsApp streaming preview acceptance
---

# macOS WhatsApp streaming preview acceptance

Date: 2026-09-04, Asia/Shanghai. Scope: FR-001, Next, **partial acceptance**.
No release or commit is implied by this report.

Historical snapshot: later on 2026-09-04 the user replaced streaming previews
with native waiting presence and complete replies. These results do not accept
the replacement implementation; see [FR-001](../feature-requirements.md).

## Deployment

- Native macOS, actual linked WhatsApp test account and signed-in desktop client.
- Base commit: `4a655d34b038d33b3b53eb8af099ca0b8c03f9c6`, with uncommitted
  FR-001 implementation. Codex CLI `0.149.1`; Baileys `7.0.0-rc14`.
- Supervisor and adapter reported ready. Process-only configuration override
  enabled previews at 1000 ms. No credential, pairing or Access Policy changes.
- The 12 feature production-source files have aggregate SHA-256
  `57499fee14229169b12124cc63edc2c6b9ad2918f6d601ef44dc227d0f355c13`.
  This identifies the feature source, not the entire deployment or an artifact.

The digest covers `src/channel-adapter.ts` and `src/index.ts` in `packages/core`;
`src/config.ts` in `packages/config`; `src/setup.ts` in `packages/cli`;
`src/protocol-schema.ts` in `packages/codex-app-server`; `src/codex-event-router.ts`,
`src/turn-coordinator.ts`, `src/conversation-turn-coordinator.ts` and
`src/profile-worker.ts` in `packages/profile-worker`; and `src/text-preview.ts`,
`src/whatsapp-adapter.ts`, `src/whatsapp-channel-account.ts` in
`packages/whatsapp-adapter`. Sort repository-relative paths lexicographically,
then hash each path, NUL, file bytes, NUL in order.

## Real interaction results

The user confirmed these UI sends at action time. Computer Use sent two
non-sensitive numbered-text requests: one private chat, then one already
authorized test group. The group request selected the actual member from the
mention menu; it was not a plain-text `@` name.

| Check | Private | Group |
| --- | --- | --- |
| Real inbound accepted into a Codex Turn | passed | passed |
| Labeled preview observed in desktop client | passed | passed |
| Provider edit visible | partial text grew from about line 27 to 54 | edited preview observed through line 30 |
| Separate final reply visible | passed | passed |
| Native terminal status | completed | completed |
| Final outbox status / attempts | accepted / 1 | accepted / 1 |
| Final numbered lines / last number | 80 / 80 | 80 / 80 |
| Final text size (SQLite characters) | 2035 | 2370 |
| Preview label stored as final output | no | no |

Read-only SQLite checks joined the two marked inbound test records to input
correlations and final outbox records, reporting only counts, terminal status,
delivery status and text-shape checks. The two inputs used two distinct Codex
Threads. These were sequential real interactions, not a simultaneous live
concurrency test. Message bodies, provider identifiers and auth material are
excluded from this report.

## Automated verification and remaining gates

Prior implementation checks: `npm test` passed 231 unit tests, 4 release-tool
tests and 4 platform-contract tests. `npm run test:contract` passed on the host
with Codex 0.149.1 (the sandbox attempt failed on App Server stdout closure).
A separate real no-tool native Turn observed 5 text deltas and the expected
terminal result. `npm run docs:build` passed both languages.

Still required before FR-001 completion/commit:

- Real long-task lifetime/edit-limit fallback; the above replies were shorter
  than the local 10-minute preview lifetime. Timer/failure unit tests are not
  evidence of actual provider expiry behavior.
- The required real macOS QQ shared-routing regression.

The test Supervisor remains available with its process-only preview override.
Restarting without that override restores the configured final-only default.
