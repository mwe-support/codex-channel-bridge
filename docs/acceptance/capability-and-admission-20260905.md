# Capability-based Codex compatibility and admission/delivery independence — Next

- Date: 2026-09-05. The original run validated an uncommitted Next snapshot based
  on `90e4449f3f4bf84015758be5c97241368acee070`, subsequently published as candidate
  `0c8ce805d0b874c527895f195ed3e293c4a8dac2`. This is not a new release or a
  modification of the immutable `0.2.0-rc.1` artifact.
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

The Linux/Docker checks above do not establish live QQ delivery there, nor a new
systemd/Windows/launchd service installation or every external provider failure mode.

## Windows follow-up — partial, not a green candidate

The Windows task's result was supplied by the user after the task-reading
interface returned empty recent-turn bodies. The reported candidate commit is
`0c8ce805d0b874c527895f195ed3e293c4a8dac2`, tree
`5189864d38ff4f5d6210cad4c391935d9295456b`. All 76 production source files match
the fingerprint above in both Git blobs and checkout bytes, without CRLF drift.
The isolated acceptance worktree was clean before preparing the test-only fix.
Host: Windows `10.0.26200`, Node `24.13.0`, npm `11.6.2`, actual Codex `0.153.4`;
the reported stable schema digest also matches the macOS/Linux value above.

| Command | Exit | Pass / fail / skip or outcome |
| --- | ---: | --- |
| `npm ci` | 0 | Installed successfully |
| `npm run check` | 1 | Unit stage: 244 / 4 / 4 |
| `npm run test:control-contract` | 0 | 5 / 0 / 0 |
| `npm run test:contract` | 0 | Native protocol contract passed |
| `npm run test:supervisor-contract` | 0 | Two-Profile isolation and stop passed |
| `npm run docs:build` | 0 | Tool tests 2 / 0 / 0; both locales built |
| `npm run test:release-tool` | 0 | 3 / 0 / 1 |
| `npm run test:platform-contract` | 0 | Static checks 4 / 0 / 0 |

Three failures are test defects: the existing Operations Inspector assertion
expected `null` even though the Windows state-directory ACL check returns `true`;
the new account-scoped Outbox test and existing native-stream test registered
database close after directory deletion, causing Windows `EBUSY`. The minimal
fix changes only two test files (7 inserted / 8 deleted lines), preserves every
assertion's security purpose, and adds no skip. Its SHA-256 is
`c3b039fbfdfb62d009aadaafb243b5a1dfa2c06f3e37ccf0b242aa822f7b84f8`;
the coordinator reproduced the exact patch bytes and passed 32 local targeted
tests. Its full macOS `npm run check` also passes 252 unit, 4 release-tool and
4 platform checks; both documentation tool tests pass. Production source is unchanged.

The fourth failure remains a host prerequisite: creating the output-file test's
`alias.txt` symlink returns `EPERM`. Windows targeted testing after the fix was
3 pass / 1 fail; no full corrected-candidate check has been reported yet. The
real pipe DACL check passed for only the current user, SYSTEM and Administrators.
SCM create-service access returned error 5, so real Windows Service lifecycle
acceptance remains unperformed. These are not additional skips or successful
acceptance. Do not broaden ACLs or silently enable system features to hide them.

The original Windows checkout remains on `main` at `90e4449`, with its two WIP
dependency lines and file digests preserved. The original stash object is
`fa72a20fd26be9db1e4857bc228fd138163efc28`. The patch was initially prepared only
in the acceptance worktree, without a Windows commit or push. The next gate is
to fetch the coordinator's new commit into a clean worktree and repeat the full
check, keeping symlink and service permissions explicit outstanding conditions.

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
- The original live run performed no database migration, Profile purge, archive
  deletion, tag, commit or release. Later candidate commits are synchronization
  checkpoints, not releases.
