# Capability-based Codex compatibility and admission/delivery independence — Next

- Date: 2026-09-05. This is uncommitted Next work based on
  `90e4449f3f4bf84015758be5c97241368acee070`, not a new release or a modification
  of the immutable `0.2.0-rc.1` artifact.
- Production TypeScript SHA-256:
  `3d2ff226783356650b3ca07992805d06db0c18a6daedc407e6ed22cb72ef4eb8`.
  Hash input is the sorted repository-relative path, newline, then file bytes
  for all 76 tracked `packages/**/*.ts` files excluding tests, contracts and
  `.d.ts` declarations. This identifies source, not a complete distribution.
- Actual administrator-installed Codex CLI: `0.153.4` on macOS and native Linux.
  Stable schema SHA-256:
  `d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a`.
  No host Codex installation was changed.

## Changes and automated counterexamples

AGENTS.md and ADRs 0028/0030/0052 now distinguish safety and ownership boundaries
from revisable algorithms. Retrieval signals remain unchanged because removing
fuzzy matching lost a labeled typo target in the earlier ablation.

Active Channel context and Turn target share a record, and queued work registers
before execution. The regression failed before the change with account active
count 0 instead of 1. It now verifies controller lookup, account/participant
boundaries, drain retention and release cleanup. Admission starts the oldest
eligible queued work, skipping busy Threads while preserving same-Thread FIFO,
capacity and expiry.

Outbox reuses independent account-scoped sweeps. Tests verify that eight claimed
records blocked on one account do not stop a sibling's later delivery; scoped
lease expiry does not reclaim another account's lease; Logical Result segment
order and existing retry/restart behavior remain intact. These are deterministic
fault tests, not claims of an induced real provider outage.

Compatibility no longer rejects a CLI by version floor or a different schema
digest. Required methods and native initialization/model discovery decide startup.
The unused compaction method is no longer a startup requirement. Optional methods
are discovered on stable and experimental surfaces. Tests accept capable schemas
with older, newer, prerelease and unknown version labels, fail closed for missing
required methods, and cover optional absence/promotion. Historical snapshots
remain evidence, not an allowlist. The diagnostic `unverified` label for 0.153.4
means it is outside the embedded historical snapshot list, not that startup failed.

## Real QQ client acceptance

The user authorized the current macOS QQ client, two supplied QQ credentials,
reuse of the existing OpenAI authentication for the second Profile, a brief
Supervisor restart, and temporary test settings. One actual Supervisor hosted
two distinct workers and App Server process trees, separate Codex homes,
Workspaces, databases and Channel Accounts. Only authentication material was
provisioned for the second Codex home; no existing Thread history was copied.
This remains application-layer isolation under one OS user and OpenAI account.

| Scenario | Observed result |
| --- | --- |
| First and second QQ Bot round trips | Both client-visible replies and accepted durable deliveries |
| Two Profile work overlap | Both Profiles observed with active native work and independent final delivery |
| Interrupt primary while secondary is active | Primary terminal status `interrupted`; secondary remained `started`, then completed with client-visible output and accepted delivery |
| Queue promotion and native approval | A queued primary input later produced a visible native command Approval Request; the same token submitted through the second Profile was rejected, leaving the primary request pending; the correct primary conversation's decline was recorded as `responded / decline`, with accepted presentation and a completed Turn |
| Same Profile, two Thread Bindings | A1/B1 were active, then A2/B2 queued in that order. After B1 finished, B2 completed while A1 remained active and A2 unstarted. B2 finished 80,587 ms before A1 ended; A2 started only after A1 ended. Client output and durable receipts confirmed completion |

All 16 inputs carrying this run's acceptance markers reached terminal state:
15 completed and one was interrupted. Every associated final delivery was
accepted; the real approval presentation was also accepted. Unmarked work is
excluded from these scenario totals. Source timestamps are Bridge correlation
timestamps; they are not provider network-latency measurements.

One early QQ paste unexpectedly included a clipboard screenshot in a group test
message. The user chose to retain that message. Subsequent scenarios used directly
typed ASCII text and draft checks. The image is not included in this report or
the repository and is not used as acceptance evidence.

## Platform checks

| Target | Exact checks and result |
| --- | --- |
| Native macOS | `npm run check`: 252 unit, 4 release-tool and 4 static platform tests pass; `npm run test:control-contract`: 5 pass; native `test:contract` and `test:supervisor-contract` pass with Codex 0.153.4; `npm run docs:build`: both locales pass |
| Native Linux, `marvel-mini-pc` | Node 22.22.1; isolated `npm ci`, `npm test` (252 + 4 + 4), `test:control-contract` (5), `test:contract`, and `test:supervisor-contract` pass using the existing administrator-supplied Codex 0.153.4 |
| Linux Docker, `marvel-mini-pc` | Production Dockerfile builds with explicit `CODEX_VERSION=0.153.4`; non-root container native protocol and Supervisor/Profile contracts pass with a fresh unauthenticated Codex home |

The isolated Docker image ID is
`sha256:937abecec91f25772a7a614a856620021131d18bd398957eb2acc1cf5521c9b9`.
The image's explicit package version is a reproducibility input, not a Bridge
compatibility gate. Additional builds with an omitted version or `latest` fail
at the version-input guard. Running containers do not self-update.

Windows acceptance was not rerun in this change. The Linux/Docker checks above
do not establish live QQ delivery there, nor a new systemd/Windows/launchd service
installation or every external provider failure mode.

## Restoration

- Original primary configuration restored, including steer mode, unlimited
  default admission and the original native reviewer selection.
- Original QQ private Thread Binding restored using `/attach`; existing history
  and group bindings retained.
- Secondary test Profile disabled, preserving its data, authentication and
  exclusive Channel Account ownership for explicit future re-enablement.
- Confirmed configuration revision:
  `fe6f3a0ed081b31d3090582c568d38555830e8dcb86b43982eebaefa7e244c47`.
- Supervisor live; primary Profile, QQ and WhatsApp adapters ready; secondary
  stopped. No active test work, pending Approval Request or pending Outbox delivery.
- No database migration, Profile purge, archive deletion, tag, commit or release.
