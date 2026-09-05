---
title: Feature requirements
---

# Feature requirements

This is the working ledger for new user-requested features, not a list of
features available in a published release. It starts on 2026-09-04. Existing
delivery and platform gates remain in [Release status](release-status.md) and
[Limits and roadmap](limits-and-roadmap.md); this ledger does not reset them.

## Update contract

1. Search for an existing requirement before appending one. Use a stable
   `FR-NNN` ID; retain deferred and completed entries rather than reusing IDs.
2. Record unresolved ideas as `discussing`. Move to `accepted` only after the
   user agrees to a feasible scope. Capture ownership, boundaries, acceptance
   criteria, and remaining decisions before writing runtime code.
3. Update both language versions when scope, implementation, acceptance, or a
   blocker changes, including during unfinished development. Each entry records
   its update date, current evidence, and next step. A blocker names the missing
   decision or evidence, not an assumed failure cause.
4. Use `in-progress` while implementing and `awaiting-acceptance` when code is
   ready but required tests remain. Use `blocked` for a dependency that prevents
   progress and `deferred` for an explicit postponement; retain the reason.
5. Use `done` only when the entry's acceptance criteria and applicable repository
   gates pass. Link code, tests, and content-free live evidence. Record an actual
   immutable release tag separately; `Next / unassigned` is not a release promise.
   Change the status back if new evidence invalidates completion.

The Markdown entries are the source of truth for requirement progress. ADRs
remain authoritative for architecture and tagged documentation for released
behavior. No separate issue database or requirements service is needed.

## Index

| ID | Requirement | Status | Release |
| --- | --- | --- | --- |
| FR-001 | WhatsApp waiting indicator and complete replies | awaiting-acceptance | `0.2.0-rc.1` |
| FR-002 | Channel Conversations visible in the host Codex App | discussing | unassigned |
| FR-003 | Independent conversations without a default concurrency cap | awaiting-acceptance | `0.2.0-rc.1` |
| FR-004 | Dashboard configuration, Profile logs and restart controls | accepted | Next / unassigned |
| FR-005 | Dashboard conversation management | accepted | Next / unassigned |
| FR-006 | QQ private-chat native streaming | awaiting-acceptance | `0.2.0-rc.1` |
| FR-007 | Query current model and reasoning with bare commands | done | `0.2.0-rc.1` |
| FR-008 | Channel Account administrator and global settings commands | deferred | unassigned |
| FR-009 | QQ and WhatsApp native approval reliability | done | `0.2.0-rc.1` |
| FR-010 | Automatic output-file delivery to the originating conversation | awaiting-acceptance | `0.2.0-rc.1` |
| FR-011 | Independent delivery per Channel Account | awaiting-acceptance | Next / unassigned |
| FR-012 | Codex compatibility from actual capabilities | awaiting-acceptance | Next / unassigned |
| FR-013 | Unified Bridge administration CLI | in-progress | Next / unassigned |

## FR-013 — Unified Bridge administration CLI

- Updated: 2026-09-05. Status: `in-progress`; release: Next / unassigned.
- User expanded service installation into a complete Bridge CLI for initial
  setup, service registration/status, Dashboard launch, Channel configuration,
  model settings, and future administration, and explicitly requested this as
  an AGENTS.md requirement. The user authorized implementation covering current
  core functionality and actual terminal-based testing and acceptance.
- Command families: retain `setup quick/full`, `config`, `profile`, `channel`,
  `dashboard`, `status`, `doctor`, existing maintenance commands, and foreground
  `supervisor run`; add `service` lifecycle and `model` discovery/query/selection.
  Extend existing groups instead of adding a competing settings CLI. Future
  operator features include their CLI, help, docs and acceptance in the same slice.
- Interaction: terminal prompts, explicit scriptable commands and Dashboard
  actions share validated operations and the authoritative control plane where
  applicable. Offline setup and service registration remain host-local edges.
  Use consistent targets/help, structured JSON where appropriate, actionable
  nonzero errors, and no unattended prompts. Existing destructive confirmations
  and no-echo secret paths remain authoritative.
- Channel configuration uses canonical configuration/check/apply and the
  existing authentication lifecycle; it cannot directly rewrite adapter or
  Profile databases. Model/reasoning choices come from the selected Profile's
  native App Server. Distinguish a target Thread from native defaults in that
  Profile's Codex home; capability-check each operation, preserve native state,
  and report unsupported capabilities without a Bridge-side settings copy.
- Native evidence: [App Server model discovery and configuration](https://learn.chatgpt.com/docs/app-server#models),
  existing [Thread model ADR](adr/0023-project-model-commands-into-native-thread-settings.md).
- Ownership: Bridge CLI/platform packaging registers one Supervisor with the
  operating-system service manager. Codex installation and upgrades remain
  administrator-owned; service choice is deployment metadata, not a competing
  Profile configuration system.
- Proposed surface: `bridge setup quick/full` delegates its optional service
  step to the same implementation as `bridge service install`; expose `start`,
  `stop`, `restart`, `status`, and `uninstall`. Preserve the existing foreground
  `bridge supervisor run`; do not add a second daemon or gateway runtime.
- Windows: preview the service identity, verified release/executable paths,
  config and control endpoint, startup policy, and required permissions. Request
  administrator authorization only for operations that require it. Registration
  must not silently run the Supervisor as LocalSystem, reuse the elevated
  administrator's Codex home, or copy credentials. Permission denial preserves
  completed setup and reports service registration as incomplete.
- Boundaries: registration and startup are distinct; status separates service
  registration/process state, Supervisor liveness, and Profile readiness.
  Stop/restart use bounded drain. Uninstall removes service registration only,
  preserving configuration, Profile data, authentication, Workspace and Codex home.
  A Windows Scheduled Task must not be reported as an SCM service.
- Acceptance: every requested command family is discoverable and usable from
  the terminal; interactive and scripted forms produce equivalent authorized
  results; targets cannot cross Profile boundaries; invalid/stale configuration,
  secret handling and native-model capability failures preserve their contracts.
  Dashboard launch preserves its loopback/authentication contract. Existing
  commands remain compatible. Setup and direct CLI produce the same service definition; repeated
  install detects existing ownership/configuration and does not overwrite an
  unrelated service; cancellation and permission denial preserve prior state;
  real target install/start/status/drain/restart/uninstall and child cleanup pass.
  Windows file-symlink test prerequisites remain a separate acceptance gate.
- Current evidence: setup only writes canonical configuration; installers select
  verified Bridge releases; platform packaging has static service examples and
  Windows IPC/ACL helpers, but no `bridge service` command. Dashboard launch and
  several Channel/maintenance commands exist; native Thread model operations
  exist in the worker, but lack a unified host-local model CLI. AGENTS.md now
  records this first-class CLI contract. No runtime or system settings changed.
- Remaining work: implement the missing command/control-plane surfaces and
  shared interactive operations, then run real platform lifecycle and applicable
  Channel acceptance. Decide Windows service identity/provisioning and elevation
  UX during that slice; a separate user-login mode is still only a proposal.
  See [upstream comparison](research/service-installation-cli-20260905.md).

## FR-011 — Independent delivery per Channel Account

- Updated: 2026-09-05. Status: `awaiting-acceptance`; release: Next / unassigned.
- User authorized the ablation follow-up, revised AGENTS.md, and real QQ client
  acceptance using two credentials for multiple Profiles. Bridge-owned scheduling:
  reuse Outbox with account-scoped claims/sends, preserve leases, receipts and
  Logical Result segment ordering; no central scheduler or new schema.
- Acceptance: a blocked/full-batch account cannot prevent another account's
  current or later delivery; scoped expiry preserves sibling leases; existing
  retry/restart/drain contracts pass. Real QQ tests cover both Profiles, overlap,
  interruption isolation, queue promotion and completed provider/client delivery.
- Related admission work stays under FR-003: same-Thread FIFO with oldest-eligible
  scanning, total capacity/TTL, and active-state consistency. Retain all retrieval
  signals until a separate measured tradeoff is accepted.
- Implemented; macOS/native Linux pass 252 unit tests, release/platform checks
  and native contracts; Docker native contracts pass. All 16 marked real QQ inputs
  reached terminal state with accepted final deliveries. Eligibility skipping,
  promoted-work approval, cross-Profile approval rejection and interruption
  isolation passed live. Original primary config/binding restored; secondary
  disabled with data retained. Windows follow-up is partial, returning this entry to awaiting acceptance;
  see the evidence for the two-file test correction and symlink/SCM prerequisites.
  Candidate commits exist on the sync branch; no release.
- [Exact evidence and limits](acceptance/capability-and-admission-20260905.md).

## FR-012 — Codex compatibility from actual capabilities

- Updated: 2026-09-05. Status: `awaiting-acceptance`; release: Next / unassigned.
- User explicitly rejected a fixed Codex CLI version because host updates are
  frequent. Codex remains administrator-supplied and is never updated by Bridge.
- Remove the version floor and fixed-version/hash host-test assertions. Probe
  generated methods and live initialization/model discovery; required capability
  gaps fail Profile-local, optional gaps disable only their feature. Recognize
  optional methods promoted to stable; keep untested combinations unverified.
- Docker takes an explicit build version rather than a supported-version default.
  Preserve historical acceptance snapshots instead of rewriting their evidence.
- Acceptance: older/newer/prerelease labels do not gate an otherwise capable
  schema; missing required methods fail closed; missing/promoted optional methods
  behave correctly; run native contracts with the current host executable and
  real QQ multi-Profile regressions. No host Codex installation changes.
- Removed version gates and fixed-version/hash assertions while retaining
  capability failure boundaries and historical verification labels. macOS, native
  Linux and Linux Docker pass native contracts with actual Codex 0.153.4; real
  QQ multi-Profile regressions pass. Other version-label behavior uses synthetic
  schema regressions, not a claim to have run every CLI version. Windows native contracts
  passed, but the complete candidate awaits full rechecking after test corrections
  and the permission prerequisites, returning this entry to awaiting acceptance.
  No host installation change; candidate commits on the sync branch, no release.
- [Exact evidence and limits](acceptance/capability-and-admission-20260905.md).


## FR-009 — QQ and WhatsApp native approval reliability

- Updated: 2026-09-05. Status: `done`; release: `0.2.0-rc.1`.
- User accepted approval verification before output-file implementation and
  authorized real tests using this host's QQ and WhatsApp clients.
- Reuse native command/file approval requests, original process-scoped responses,
  participant binding and the existing durable Outbox; do not alter Reviewer policy.
- Acceptance: real QQ and WhatsApp request/decision round trips; rejection,
  duplicate/expired token, wrong participant/conversation, lost generation and
  delivery failure regressions. Separate provider receipts from client visibility
  and native execution. No claim of delivery outside QQ's reply permissions.
- Implemented native request/Turn cancellation cleanup, generation-close write
  race protection and visible decision/rejection feedback. Real QQ and WhatsApp
  private approval, decision, repeated token, cancellation and timeout checks
  passed; cross-channel token use was rejected. Original configuration and Thread
  bindings were restored. 241 unit tests, 4 release-tool tests, 4 platform tests,
  host-native protocol checks and bilingual docs builds passed.
- [Acceptance and exact limits](acceptance/channel-approval-reliability.md).
  Unsupported request families remain fail-closed; not a live group or file-change
  approval claim, nor a promise to bypass provider delivery limits.

## FR-010 — Automatic output-file delivery

- Updated: 2026-09-05. Status: `awaiting-acceptance`; release: `0.2.0-rc.1`.
- Accepted: the user selected automatic model-mentioned file delivery, without a
  `/file` command. The first implementation recognizes local Markdown links in
  completed final answers, not arbitrary prose, examples, or Workspace scanning.
  An explicit Profile opt-in preserves existing deployments' export behavior.
- Bridge-owned transport must validate file scope/type/size, retain immutable
  bytes for durable retry, reuse the Outbox and provider SDK upload/send methods,
  and distinguish upload, message acceptance and recipient download.
- Do not expose a public file server, read arbitrary host files, copy Codex
  history, or introduce a Channel Administrator for this feature.
- Acceptance: real QQ and WhatsApp download of harmless generated files with
  matching digests; isolation, invalid paths/symlinks, size limits, upload/send
  failure and restart retry checks. Implement after FR-009's approval gate.
- Real macOS QQ and WhatsApp private/group attachment delivery passed: actual
  client downloads match original and Outbox SHA-256. Missing/out-of-scope links
  produced visible rejection notices without file deliveries in both private chats.
- Implemented: bounded Workspace-link snapshots, shared media quota, schema 11
  attachment Outbox, QQ upload/send and WhatsApp document/account forwarding.
  250 unit, 4 release-tool and 4 platform checks pass; native Codex 0.149.1
  protocol contract and bilingual documentation build pass on macOS.
- Deployment gate passed with explicit user authorization: drained Profile,
  verified operator snapshot, exact source digest match, explicit schema 10→11
  migration, backup finish and confirmed configuration apply. Automatic file
  delivery is enabled on the macOS test Profile. Upload/send failure and durable
  restart retry are covered by deterministic tests, not live provider fault claims.
- Remaining: attachment-path acceptance on native Linux, Linux Docker and
  Windows, plus applicable release/rollback gates. No commit or release has been
  made for this feature. See [acceptance evidence](acceptance/automatic-output-files.md)
  and [usage and exact limits](output-files.md).

## FR-008 — Channel Account administrator and global settings commands

- Updated: 2026-09-05. Status: `deferred`; release: unassigned. No runtime
  authority or configuration has changed.
- Deferred to avoid persistent inheritance, override and batch failure complexity;
  keep per-Thread model/reasoning commands. The proposal below is not authorized implementation.
- User proposal: configure one administrator per channel; that participant uses
  private-chat slash commands such as `/model MODEL_ID --global` to change
  channel-wide settings. Existing commands without the flag keep their scope.
- Proposed terminology: Channel Account Administrator identifies one provider-
  authenticated participant for one Bot/login account, not a private Thread ID,
  nickname, QQ display number, or cross-provider identity. Private chat is the
  management entry point. The host administrator assigns/removes the role through
  explicit configuration apply; no configured administrator means no global authority.
- Proposed boundary: `--global` targets only that Channel Account's authorized
  bindings, not sibling QQ/WhatsApp accounts or the entire Profile. Keep ordinary
  access checks. The role does not grant host administration, account revocation,
  archive deletion, Codex permissions, or approval on someone else's behalf.
- Start with explicit support for model/reasoning commands, not a universal
  global modifier for `/approve`, `/stop`, `/new`, or arbitrary slash commands.
  Each Thread change must use the native settings operation. Do not write the
  Profile-wide Codex config, which could affect sibling accounts.
- Open decision: does global mean a one-time batch over existing bindings, or
  also persistent defaults for future Threads? The latter needs an explicit
  ownership/persistence exception to ADR 0023 and AGENTS.md, not a silent Bridge
  model cache. Also decide whether to overwrite prior per-Thread selections and
  whether later local overrides remain allowed.
- Before implementation, define next-Turn timing, bounded batch confirmation,
  partial failures and native readback, model/effort compatibility, and shared
  Thread deduplication. A Thread also bound outside the selected Channel Account
  must not be changed silently. Never claim atomic cross-Thread updates.
- Next: resolve scope/default semantics with the user, then update the glossary
  and relevant role/settings contracts before implementing. Existing native
  methods and live isolation evidence: [FR-007 acceptance](acceptance/model-reasoning-queries.md).

## FR-007 — Current model and reasoning queries

- Updated: 2026-09-04. Status: `done`; release: `0.2.0-rc.1`.
- Bare `/model` and `/reasoning` read the current bound Codex Thread's model
  and reasoning effort. Existing argument-taking selection commands stay intact.
- Codex owns these values; reuse native Thread settings retrieval without
  overrides, a Turn, or a Bridge-side settings cache. A null effort is reported
  as Codex default/unspecified, not guessed from a model catalog.
- Queries are available in authorized private and group conversations, including
  shared groups; existing shared-group restrictions still apply to mutations.
  An unbound conversation receives an explicit no-Thread reply, not a new Thread.
- Acceptance: parsing, native read-only calls, shared-group authorization,
  missing bindings/null effort and selection regressions; deploy on macOS and
  verify real QQ queries and parameterized commands before marking complete.
- Implemented via the existing command parser and `readThreadSettings`; no new
  configuration or persistence. Regression tests cover queries without experimental
  update support, null effort, missing binding, shared-group mutation rejection,
  and preserved parameterized selection. Real QQ private/group queries and
  selection/readback passed on the deployed macOS candidate.
- Added acceptance: record settings in two independently bound conversations;
  change only one, read both again, and restore the changed Thread. Verify model
  and reasoning selection do not propagate to the other Thread in the Profile.
- Isolation passed for two QQ conversations in one Profile; private settings
  were restored, the group remained unchanged, and queries created no model
  Turns. The live group test also fixed leading opaque mention normalization.
  [Acceptance evidence](acceptance/model-reasoning-queries.md) records 238 unit
  tests, native protocol checks and exact live scope. Other feature gates remain open.

## FR-001 — WhatsApp waiting indicator and complete replies

- Updated: 2026-09-04. Status: `awaiting-acceptance`; release: `0.2.0-rc.1`.
- Revised request: show a visible waiting indication while Codex thinks or uses
  tools; send the complete text only after the Turn ends. This supersedes the
  earlier simulated-streaming request and its unreleased `streamingPreview`
  configuration.
- This rollback applies to WhatsApp simulated text streaming only. It does not
  cancel QQ private-chat native streaming (FR-006). QQ groups and WhatsApp send
  complete text replies; waiting indications depend on each provider's API.
- Ownership: Codex owns Turn lifecycle and output. The Bridge projects accepted
  Channel work into Baileys' native chat presence; WhatsApp owns its visual
  presentation. No reasoning/tool contents or invented progress stages.
- Contract: pinned Baileys `7.0.0-rc14` implements
  `sendPresenceUpdate("composing" | "paused", jid)`; see
  [upstream presence documentation](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/socket/presence-receipts.md)
  and [adapter behavior](whatsapp-adapter.md#waiting-indicator).

### Scope and acceptance

- Automatic native typing indication for accepted WhatsApp work, before text
  generation, refreshed every 5 seconds. No setup option or artificial response
  delay. QQ stays unchanged.
- Stop refreshing on completion, failure, interruption or disconnection. Overlapping
  participant-scoped Turns in one group share the indication until the last ends.
  No indication for denied/passive/queued-but-not-started inputs.
- Best effort, no text messages or edits, no presence records in the durable outbox.
  Presence failure cannot block Codex or the existing complete-result delivery.
  WhatsApp determines whether the UI shows a bubble or a typing label; no custom
  bubble or distinction between thinking and tools is promised.
- Verify immediate presence, refresh without deltas, concurrent chats/Turns,
  stale socket cleanup, rejection/stalled send, and unchanged final-only delivery.
  Complete real private/group waiting and cleanup acceptance on local macOS, plus
  the required QQ shared-path regression before committing.
- Implementation now removes preview buffers, text-delta callbacks/capability
  probes and preview configuration; adds the native presence lifecycle.
- Historical [stream-preview acceptance](acceptance/macos-whatsapp-stream-preview.md)
  applies only to the superseded implementation, not to the revised requirement.
- Verified: `npm test` passes 225 unit, 4 release-tool and 4 platform-contract
  tests; `npm run docs:build` passes both locales; `git diff --check` passes.
  Host `npm run test:contract` passes with Codex 0.149.1 and schema SHA-256
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`.
- Initial deployment on local native macOS: existing linked account, no preview override,
  credentials/policy unchanged; Supervisor live, Profile and adapter ready.
  Configuration revision:
  `2566334a2c74896c3da5d201e701aa305068245a42f42f1eea0cee0e928b67cf`.
  Four production-source files (core channel-adapter, profile-worker,
  whatsapp-adapter and whatsapp-channel-account) have aggregate SHA-256
  `e921a108d4faf1d00e70b2000d9ad1e54a81639ee9af0f5b0b3cfbaa3c2f83d9`
  over each ordered relative path + newline + file bytes. This is source
  identification, not a complete deployment/artifact digest.
- Subsequent deployment includes FR-003's unlimited admission; see its current
  configuration revision below. Before FR-003 deployment, five typing-build real Turns (four private, one
  group) completed with accepted, first-attempt final deliveries; the group Turn
  lasted 544,788 ms. These receipts do not verify typing visibility or cleanup.
- Next: observe the user's real WhatsApp private/group waiting and complete-reply
  tests, then finish the QQ gate. Deployment readiness is not visual acceptance.
  No commit or release yet.

## FR-002 — Channel Conversations visible in the host Codex App

- Updated: 2026-09-04.
- Request: distinguish private/group conversations in the deployment host's
  Codex App project view. Hermes dispatch's `session_key` naming is historical
  motivation, not an implementation dependency.
- Ownership: Bridge Conversation Keys and Thread Bindings select the route;
  Codex owns Thread metadata, history, project presentation, and desktop state.
- Evidence: native `thread/name/set` sets a Thread title. `thread/list` supports
  `cwd` and source filters; the official documentation says its default source
  filter includes `cli` and `vscode`, with `appServer` available explicitly.
  These protocol facts do not establish the desktop app's own query behavior.
  See [Codex App Server](https://learn.chatgpt.com/docs/app-server).
- Local boundary: [TurnCoordinator](https://github.com/mwe-support/codex-channel-bridge/blob/4a655d34b038d33b3b53eb8af099ca0b8c03f9c6/packages/profile-worker/src/turn-coordinator.ts)
  starts Threads using the Profile Workspace, while
  [App Server startup](https://github.com/mwe-support/codex-channel-bridge/blob/4a655d34b038d33b3b53eb8af099ca0b8c03f9c6/packages/codex-app-server/src/app-server-process.ts)
  supplies a Profile-specific `CODEX_HOME`. A shared Workspace path or changed
  title alone is not evidence that the desktop can discover these Threads.

### Proposed minimum scope — not yet accepted

- One Profile Workspace remains one project scope; show distinct bound Threads
  within it. Preserve configured group conversation/participant Thread scope.
  Do not create a separate Workspace for every private/group conversation.
- Use native Thread naming with a readable Channel/type label and an opaque
  internal routing suffix, for example `[WhatsApp][group] Support · c-7f92`.
  This is a fictional display example, not a new routing key. Keep raw provider
  IDs out of titles; display labels must not control identity or permissions.
- First establish discovery and viewing only. Desktop write/control handoff is
  a separate decision: two clients must not concurrently control one Thread.
- Preserve separate Profile Codex homes. Do not copy rollout files, edit Codex's
  private database, spoof source identity, or merge Profiles into the desktop's
  default home to force visibility.

### Open questions and acceptance gate

1. Does the deployed desktop version provide a supported way to view the
   selected Profile's Codex home and include App Server-originated Threads?
   No such path has been verified for this requirement yet.
2. Is viewing sufficient, or must the desktop also take over active work and
   return control to the Channel? Recommend viewing first.
3. Verify actual desktop discovery, title, project grouping, restart persistence,
   cross-Profile isolation, and duplicate display names using distinct private
   and group conversations. API listing alone is insufficient acceptance.

Next: agree on viewing versus control handoff and run a native-capability spike
on the deployed desktop without changing production history or Profile
isolation. If discovery requires unsupported storage changes, keep this
requirement blocked/deferred and explain the boundary before implementation.

## FR-003 — Independent conversations without a default concurrency cap

- Updated: 2026-09-05. Status: `awaiting-acceptance`; release: `0.2.0-rc.1`.
- Follow-up, Next / unassigned: the user authorized audit A4's active-state
  cleanup. The queued-work regression failed before the fix (account active
  count 0 instead of 1) and passes after co-locating Channel context and Turn
  target and registering promoted work. It also covers controller lookup,
  participant checks, drain retention and release cleanup. FIFO and admission
  limits were unchanged in A4; the subsequent Next amendment to ADR 0052 enables cross-Thread eligibility scanning. This follow-up is not part of the immutable release;
  `npm run check` passes 250 unit, 4 release-tool and 4 static platform tests;
  `npm run docs:test` passes 2 tool tests and `git diff --check` passes. Subsequent live QQ
  promotion/approval, eligibility and interruption isolation passed; primary config
  and original binding are restored. Other existing FR-003 gates retain their status.
  See [this run's evidence](acceptance/capability-and-admission-20260905.md).
  Candidate code is deployed locally, not committed or released.
- Request: group/private conversations must not block each other merely because
  they share a Profile; no default Bridge concurrent-Turn limit.
- Ownership: Bridge admission only. Codex owns each Thread/Turn; no new process,
  gateway, scheduler or copied history per conversation.
- Scope: `admission.maximumActiveTurns: null` means unlimited and becomes the
  default. An explicit integer cap remains supported for operators; existing
  explicit caps are not silently discarded. Full setup supports unlimited.
- Preserve same-Thread native steer or explicit queue mode, access/initiator
  checks, account rate limits, bounded queues and disk protection. This does not
  promise unlimited host resources, absence of model/provider limits, or safe
  concurrent edits to shared Workspace files.
- Acceptance: a group and private chat with distinct bindings start together;
  stopping/failing one does not stop the other; same-Thread steer/queue stays
  correct; finite caps still work; no hidden default of one in worker/setup.
  Verify real macOS WhatsApp overlap and QQ shared-path regression before commit.
- Evidence: live config revision 2566334a2c74896c3da5d201e701aa305068245a42f42f1eea0cee0e928b67cf
  used steer and maximumActiveTurns=1. Live private/group correlations used two
  distinct Thread IDs and bindings. A read-only in-memory admission reproduction
  rejected the second Thread at cap 1 and started it at cap 2.
- Implemented nullable unlimited configuration, schema and worker defaults,
  full-setup choice and targeted regression tests. `npm test`: 229 unit,
  4 release-tool and 4 platform-contract tests pass. Both documentation locales,
  `git diff --check` and host Codex 0.149.1 protocol contract pass.
- Native macOS deployment now explicitly uses `maximumActiveTurns: null`;
  configuration revision
  `cfb8aa81049fc290a4144d7624eb31317b0c8d0dfb5d1c5de18cd506cab949bc`.
  Supervisor, Profile and WhatsApp adapter report live/ready. Previous work
  completed before bounded restart. Credentials/policies unchanged; the local
  Dashboard process remains running across the restart.
- Real macOS overlap verified on 2026-09-04: private and group work used two
  distinct Threads, overlapped for 23,085 ms and completed independently; both
  final outbox records were accepted on attempt 1. This proves concurrent
  execution, not typing visibility or interruption isolation.
- Next: independent interruption, typing visibility/cleanup and QQ shared-path
  acceptance. Not committed/released.

## FR-004 — Dashboard configuration, Profile logs and restart controls

- Updated: 2026-09-04. Status: `accepted`; release: Next / unassigned.
- Request: show the active editable configuration by default, Profile-scoped
  live operational logs, and explicit restart requirements/actions; use Hermes
  as UX research, not a runtime dependency.
- Ownership: Dashboard presents the authenticated host-local control plane.
  Supervisor owns configuration revision and worker lifecycle; service managers
  own the Supervisor process. Secret values remain in the existing no-echo path.
- Scope: show the actual config path and editable non-secret YAML, distinguish
  disk contents from active settings and environment overrides, and provide
  validate/preview/confirm/apply with stale-edit protection. No silent save/apply.
  Show the configured secrets-file location and safe update instructions/status,
  not secret contents or an arbitrary-file browser.
- Logs: a bounded, content-free operational feed filterable by Profile, with
  timestamps, event codes, states and errors. Source it from real worker and
  Supervisor events through IPC, not Dashboard page-refresh events, archive
  bodies, Codex history or direct browser access to log files. Log persistence
  and rotation remain platform-owned.
- Restart: separate restart of one Profile from restart of the Supervisor.
  Preview active work, drain consequences and scope before confirmation.
  Profile restart must not affect siblings. Supervisor restart may be offered
  only through a verified service-manager capability; foreground deployments
  show an explicit unsupported/manual instruction, not a fake success button.
- Current gaps verified in source: Dashboard has only status/config-plan/apply
  and its own 100-event list. Worker child currently forwards health but not
  ordinary Turn/delivery events; parent drains/discards worker stdout/stderr.
  Configuration planning compares Profile settings, not secrets-file contents
  or changes to Supervisor settings. Reapplying unchanged YAML is therefore not
  proof that edited secret values or runtime-wide options were reloaded.
- Acceptance: stale editor/save conflict, invalid configuration rollback,
  environment precedence, no secret exposure, live Profile log filtering,
  explicit restart impact, sibling isolation and foreground unsupported state.
  Validate in the rendered Dashboard and real macOS runtime before committing.
- Next: incorporate [Hermes research](research/hermes-dashboard-operations.md),
  close the configuration/reload semantics gaps, then implement through existing
  control-plane interfaces. No Dashboard runtime change has shipped yet.

## FR-005 — Dashboard conversation management

- Updated: 2026-09-04. Status: `accepted`; release: Next / unassigned.
- Request: include Channel Conversation management in the Dashboard.
- Initial scope: filter by Profile and Channel, distinguish private/group
  conversations, display bound Codex Thread identifiers and current
  running/waiting/terminal state, and provide confirmed native interruption
  of the exact selected active Turn through host-local administration.
- Ownership: Bridge owns Conversation/Thread Binding identifiers; Codex owns
  Threads, Turns and history. This is separate from FR-002's host Codex App
  visibility requirement. No parallel transcript database or Codex private-file
  access is introduced.
- Before implementation, verify native read/interrupt schemas and the
  administrator's control scope; use exact Thread/Turn/generation correlation
  so stale pages cannot interrupt replacement work or another conversation.
- New Thread, rename, attach/detach, resume, archive and history-content viewing
  are possible later slices, not implied bulk deletion or desktop control
  takeover. Their detailed permissions and confirmation flows remain discussing.
  Dashboard operations must not bypass the existing Profile Workspace boundary.
- Acceptance: independent private/group lists and control targets, cross-Profile
  isolation, stale-state rejection, independent interruption under concurrency,
  no inference that deleting a Bridge binding deletes Codex history.
- Next: design the minimal native/control-plane projection and rendered flows
  alongside FR-004. Requirement recorded; not implemented or released.

## FR-006 — QQ private-chat native streaming

- Updated: 2026-09-04. Status: `awaiting-acceptance`; release: `0.2.0-rc.1`.
- User reaffirmed the delivery contract: QQ private replies use Tencent's native
  C2C streaming endpoint; QQ groups and WhatsApp do not stream answer text and
  retain complete-result replies. FR-001's WhatsApp rollback does not override
  this contract. This records an omitted requirement, not a new choice for the user.
- Ownership: Codex owns generated answer text and Turn completion. The Bridge
  projects permitted answer events into QQ's native stream; Tencent owns the
  stream identity, frame acceptance and client rendering. Do not expose raw
  reasoning/tool output or simulate a stream by sending many ordinary messages.
- Evidence: [QQ platform research](research/qq-long-running-delivery-limits.md)
  distinguishes the C2C stream endpoint from unsupported group streaming.
  Before this fix the QQ Adapter exposed only discrete `sendText`; a successful ordinary
  reply receipt is not streaming acceptance. The missing path is an implementation
  gap, not expected private-chat behavior or an operator configuration mistake.
- Acceptance: real macOS QQ private chat visibly updates the same native message
  before Turn completion and receives an accepted DONE frame. Persist the stream
  identity/sequence and reconcile terminal delivery with the existing Logical
  Result/outbox so successful streaming does not produce a second full reply.
  Verify short/long tasks, expiry, rate limits, interruption, connection/process
  loss, ambiguous frame outcomes and complete-result fallback without losing text.
  Confirm QQ groups and WhatsApp retain non-streamed complete replies, and
  concurrent conversations cannot mix output or block one another.
- Implemented in the working tree: phase-aware native answer deltas, QQ-only C2C
  stream frames, schema-10 delivery metadata, coalescing, durable DONE receipt
  recovery, ordinary Outbox fallback and lossless oversized QQ segmentation.
  See [test evidence](acceptance/qq-native-streaming.md).
- Local deployment: after verified backup and operator confirmation, explicit
  schema 9→10 migration completed; QQ and WhatsApp are ready and Dashboard is retained.
  The first live attempt exposed an incorrect zero remaining-length guard. Its
  regression test and fix passed; the fresh real QQ run accepted 44 native frames
  including DONE, visibly grew before completion, and reused the same final receipt.
  Short replies also passed. Complete the remaining boundary acceptance recorded
  in the evidence before marking this requirement done or releasing it.
