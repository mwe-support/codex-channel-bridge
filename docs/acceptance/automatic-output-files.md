# Automatic output files — Next acceptance

Date: 2026-09-05. Native macOS, Node.js host runtime, Codex CLI 0.149.1,
Tencent SDK 1.0.4 and Baileys 7.0.0-rc14. Historical implementation checkpoint:
the then-uncommitted working tree based on
`4a655d34b038d33b3b53eb8af099ca0b8c03f9c6`, version `0.1.0-dev`.
The source hashes below identify that checkpoint, not a later tagged tree; use
the tag's release notes and gates for release identity. Scope and opt-in:
[output files](../output-files.md).

## Authorized migration and deployment

1. Prepared a Profile backup with bounded drain and an operator manifest.
   No active work or pending deliveries remained. The independent Dashboard
   stayed running.
2. The operator copied Bridge state, full Codex home, Workspace, configuration
   and the external secrets file to an owner-only local snapshot. Compared
   regular-file paths, modes, sizes and SHA-256; compared symlink targets without
   following them. State: 894 files; Codex home: 1,792 files and three symlinks;
   Workspace: empty before the file tests. Snapshot material is not in Git.
3. `bridge restore validate` returned valid with no issues. The migration
   source digest exactly matched the snapshot's database/WAL digest:
   `350ba889350e48ca06349b010928d141858e44ca4f08c1c9475820231d83bbdb`.
   Explicit `bridge migrate apply` changed schema 10 to 11; no automatic startup
   migration or Codex-owned data rewriting occurred.
4. Finished the backup hold, enabled `media.sendOutputFiles: true` through
   configuration check/plan/confirmed apply, and restarted the affected Profile.
   Both adapters were ready. Configuration revision:
   `29a0f9262a8b79dd50bc4e2ede073b9b9b791198b029cbe03f5f9b99168944d7`.

The pre-migration snapshot remains available. Validation and byte comparison are
not a restore/rollback rehearsal; schema 11 cannot be downgraded by merely
starting a schema-10 binary.

## Real client results

Each successful scenario used a real desktop-client message to the configured
test account/group, a native Codex Turn creating a harmless Workspace text file,
and a final local Markdown link. Group messages selected the actual Bot/Momo
entry in the client's native mention picker, not a plain-text nickname.

| Route | Provider result | Recipient download SHA-256 |
| --- | --- | --- |
| QQ private | File accepted, attempt 1, 23 bytes | `1b2da0bfe27a042ee9fc9f51fd55ccd42daa80b1127ef9dd24b29637d632067f` |
| WhatsApp private | File accepted, attempt 1, 23 bytes | `4aab4e6b78117f69cbb1870d447298bc9fdad23a06a014e4641903bca3cca1af` |
| QQ group | File accepted, attempt 1, 29 bytes | `9260e6d2402cf0e76811190bca7470deb30443eb15d3b6a73f1ea2537bf2d1b3` |
| WhatsApp group | File accepted, attempt 1, 29 bytes | `6f9589dd6b0eed606e47ab8f8f2b6cc988f278df4bb0661e1028268e00629d84` |

All four downloads matched the original file and committed Outbox snapshot.
This verifies byte-preserving transport, not that the model obeyed every file
formatting instruction. QQ used its download/save action; WhatsApp used Save to
Downloads. Merely opening a document preview was not counted as download proof.
WhatsApp displayed the final link as literal text alongside a usable document
card; native Markdown-link rendering is not promised.

Missing-file and parent-directory links in both private conversations produced
visible attachment-rejection notices and no file Outbox rows. An additional
WhatsApp task with a requested 45-second delay delivered its file normally;
that is not a disconnected-adapter or ambiguous-send test. The host-local
disconnect action requires account quiescence; this protection was not bypassed.

A subsequent normal Supervisor stop reported draining, stopped and process exit
0; restarting the same configuration returned both adapters to ready. Before and
after restart: 50 terminal inputs, 65 accepted Outbox records, five file records
(two QQ, three WhatsApp), each still at attempt 1, and SQLite `quick_check=ok`.
No accepted attachment was re-enqueued in this observed restart. The Dashboard
listener remained available; its protected page is not served at the root URL.

## Automated checks and exact limits

- `npm test`: 250 unit tests, four release-tool tests and four platform contract
  tests, all passed on macOS. File checks cover scope and exclusions,
  symlinks/hard links, source modification, snapshot tampering, size/shared quota,
  atomic result metadata and conflict detection. A real SQLite close/reopen and
  expired lease preserve file metadata, Logical Result, record and reply sequence.
- Adapter fault injection covers QQ upload rejection/rate limit/uncertainty,
  no send after failed upload, send uncertainty and fresh upload on retry;
  WhatsApp combined upload/send failure and missing receipt remain ambiguous.
  Outbox tests cover retry identity, unavailable adapters and missing snapshots.
  These are deterministic tests, not deliberately induced provider outages.
- `npm run test:contract` passed on the actual host with Codex schema SHA-256
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`.
- `npm run docs:build` and `git diff --check` passed for the bilingual update.

Native Linux, Linux Docker and Windows acceptance of this new attachment path
remain unverified. No live provider-rate-limit, reply-window-expiry, power-loss,
or ambiguous-send duplicate-window claim is made. Existing release and rollback
gates still apply; FR-010 remains awaiting acceptance outside the verified scope.

Runtime source identifiers (not a full build-artifact digest):

| Source | SHA-256 |
| --- | --- |
| `profile-worker/src/output-files.ts` | `b797fcfc61ae490bb2e4a2be4cf9a867def0a14b7a5e4d7a532ce6be89a9205e` |
| `profile-worker/src/delivery-outbox.ts` | `06933cce8daabf5a960870c5936fb4e1375b53f1e6546bcf0548da7272c13c45` |
| `qq-adapter/src/qq-adapter.ts` | `2000101c7773d28ffb3d0e53fdb0873fb1d021ce30a00d424d588eed59aad5ab` |
| `whatsapp-adapter/src/whatsapp-adapter.ts` | `deb0260b3ac4c88d587e469fac46fd084dd1a159446510d8ba61f2075c054221` |

No message/file bodies, raw provider identities, credentials, signed URLs or
pairing material are retained in this record.
