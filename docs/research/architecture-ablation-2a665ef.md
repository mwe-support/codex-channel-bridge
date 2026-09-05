---
title: Architecture ablation audit at 2a665ef
---

# Architecture ablation audit at 2a665ef

Audit date: 2026-09-05. Retain the process isolation and persistence architecture. Prioritize duplicated state and type declarations. Current evidence supports targeted cleanup, not a wholesale rewrite, collapsing all packages, or removing reliability layers.

This records the original audit and discussion proposal. During the audit, all variants ran in an isolated temporary source snapshot. Runtime source, AGENTS.md, services, credentials and runtime data in the main workspace were untouched; the only added repository files were this report and its Chinese counterpart. Subsequently, the user authorized A4, rule revisions, capability-based Codex compatibility and real QQ acceptance. Current progress is recorded under FR-003/011/012 in [Feature requirements](../feature-requirements.md) and [acceptance evidence](../acceptance/capability-and-admission-20260905.md); the fixed-baseline findings and then-pending proposals below remain historical audit evidence.

## Baseline and coverage

- Requested baseline: `2a665ef0029577e4c09036501deca775cc65b6a2`, version `0.2.0-rc.1`.
- Actual workspace HEAD: `90e4449f3f4bf84015758be5c97241368acee070`. Its only differences are three website files with 20 added lines. Runtime source and AGENTS.md are identical.
- Inventory: 12 runtime packages, 76 production TypeScript files, 20,096 lines, excluding tests, contract files, declarations and generated output. Website code is excluded. Detailed tracing focused on inbound archival, access/admission, Turn correlation, approval-controller lookup, terminal delivery, storage RPC, retrieval and supervision. This is not an exhaustive security or platform review.
- `profile-store`: 5,804 lines; `profile-worker`: 4,868; `control-plane`: 2,893. Together they contain approximately 67.5% of production TypeScript. Size identifies investigation targets; it does not establish redundancy.
- The fixed snapshot was exported with `git archive`. Installed third-party dependencies were reused, while internal workspace package links resolve into the isolated snapshot to avoid testing the main checkout's build output.
- Local Node.js `22.23.1`, npm `10.9.8`. Baseline build, 250 unit tests, four release-tool tests and four static platform contract tests passed. Static platform checks are not live Windows/Linux/Docker acceptance.
- No real QQ/WhatsApp messages, host Codex protocol contracts or remote lifecycle tests ran. No variant was committed, released or deployed.

## Priority findings

### P1: duplicated active state loses queued work's controller and account count

Locations: `packages/profile-worker/src/channel-ingress-controller.ts:139-148`, `:166-185`; consumers in `profile-worker.ts:743-759` and `:1472-1481`.

`AdmissionController.release()` promotes a candidate into active work. `ChannelIngressController.release()` retrieves its payload from `#queued` but never inserts it into `#active`. Later, `markTurnStarted()` writes a third map, `#turnTargets`; controller lookup needs the payload from `#active` again.

Minimal reproduction: start one input, queue a second, finish the first, then mark the promoted input's Turn as started. Actual results are overall `active = 1`, account `active = 0`, and `controllerForTurn()` returning `undefined`. Account quiescence checks can consequently miss this active work, and approval routing cannot find its Channel controller. These are measured synthetic controller results, not a claim that a live account incident occurred.

Experiment A4 stores an active work payload and its Turn target together, removes `#turnTargets`, and registers promoted work. Independent Ingress maps decrease from three to two, with one net added line. All 250 existing unit tests and the new queue assertion pass. Reducing state that must stay synchronized matters more than achieving a negative line count. This does not justify moving the native Codex Turn lifecycle into the Bridge.

### P2: serial Outbox batches block independent accounts in one Profile

Locations: `packages/profile-worker/src/delivery-outbox.ts:93-105`, `:72-90`.

A sweep claims up to eight records by default, then awaits each delivery in sequence. A pending first QQ send prevents a ready WhatsApp send in the same batch from starting. A new probe holds the QQ send on a manually released Promise; only the QQ call is observed before release, failing the independent WhatsApp assertion. Existing tests still all pass.

This is Bridge delivery scheduling evidence, not proof that adapters need separate processes. A subsequent candidate should let distinct Channel Accounts progress independently while preserving Logical Result segment order, database leases, retries and receipt checks. Replacing the whole loop with `Promise.all` alone would not establish fairness across batches, account ordering or bounded shutdown; this audit does not present that as a verified fix.

### Design tradeoff: a strict Profile FIFO causes head-of-line blocking

Location: `packages/profile-worker/src/admission-controller.ts:130-151`.

With an explicit concurrency cap of two and queue mode, let A/B be active and A2/C queued. When B completes, A2 remains blocked by A. The loop breaks and C cannot use the available slot. A deterministic reproduction confirms this behavior.

This follows strict FIFO; it is not reported as a failure of default unlimited admission. The decision is whether finite-cap operation prioritizes global enqueue order or allows temporarily ineligible work to be skipped so independent conversations wait less. Both guarantees should not be promised together.

## Executed ablations

Each independent variant starts from the same baseline and retains existing tests unchanged. A4 adds a behavior assertion. A1+A2+A4 were then combined to check interactions, followed by source restoration and rebuilding. Line deltas count physical source lines, including comments, excluding tests and this report.

| Variant | Removal or adjustment | Line delta | Validation | Assessment |
| --- | --- | ---: | --- | --- |
| A2 | Derive storage RPC argument/result types from method signatures; retain the explicit method set and runtime dispatch | −29 | Build and 250/250 unit tests pass | Redundant declarations can be simplified |
| A1 | Delete the unused `BridgeAction` union/export; retain the used `AuthorizedParticipantContext` | −28 | Build and 250/250 unit tests pass | Dead type; no runtime performance gain |
| A4 | Co-locate active payload and Turn target, and register promoted queued work | +1 | 250/250 unit tests and new queue assertion pass | Prioritize as a correction candidate |
| A3 | Remove fuzzy computation/helpers while retaining other signals and query boundaries | −44 | Build passes; 249/250 unit tests pass; relevance regresses | A feature tradeoff, not a safe deletion |
| A1+A2+A4 | Combined validation | −56 | 250/250 unit tests and new queue assertion pass | Ready for separate implementation review, not live acceptance |

`shrink:` derive storage RPC types from original methods instead of manually maintaining the same signatures in the implementation and protocol. Location: `packages/profile-store/src/async-profile-store.ts:51-123`.

`delete:` remove `BridgeAction`, which has no repository code consumers; retain the interface used for approval context. Locations: `packages/core/src/bridge-action.ts:1-27`, `packages/core/src/index.ts:29`.

The safe cleanup candidates total 57 fewer lines and zero removed dependencies. Do not count A3's 44 lines as behavior-preserving savings. A4 improves state structure rather than shrinking code. A2 uses built-in TypeScript `Parameters` / `ReturnType`, introduces neither a generator nor arbitrary dynamic method invocation, and preserves the transport's `null` response for `close`. [Official TypeScript documentation](https://www.typescriptlang.org/docs/handbook/utility-types.html#parameterstype)

## Retrieval: faster queries with observable recall loss

The experiment uses a temporary SQLite database, synthetic text, three warmups and 21 timed repetitions per query. Four queries each have one labeled target: an English exact match, a recent misspelling, a Chinese substring, and an old misspelled target outside the recent candidate window. A fifth query has no match. Recall@5 indicates whether the single target appears in the first five results.

The initial corpus contained 2,003 records with the relevant messages among the newest two. Without fuzzy matching, recency alone retained the recent typo target in the top five, though its rank fell from first to second. To test that recency confound, another 100 unrelated records were appended and both implementations were compared on the identical 2,103-record corpus.

| Query | Baseline median ms | A3 median ms | Baseline / A3 Recall@5 |
| --- | ---: | ---: | --- |
| English exact | 7.727 | 3.182 | 1 / 1 |
| Recent misspelling | 7.455 | 2.978 | 1 / 0 |
| Chinese substring | 7.665 | 2.987 | 1 / 1 |
| Old misspelling | 7.966 | 3.026 | 0 / 0 |
| No match | 7.159 | 2.931 | Not applicable; both return five records |

Average Recall@5 across the four positive synthetic queries decreases from 0.75 to 0.50. These numbers are not business-query quality or end-to-end response latency. There was no multi-machine, cold-cache or randomized multi-process measurement; production speedup is not inferred.

The baseline also has two existing limits: fuzzy matching examines only the most recent 1,000 candidates, missing the old typo target; recency contributes candidates unconditionally, so a no-match query can return unrelated records. Locations: `packages/profile-store/src/hybrid-retrieval.ts:9`, `:66-72`, `:106-119`. Define no-match behavior and historical coverage before adding more algorithms to satisfy a six-signal checklist. Preserve Chinese substring cases. SQLite FTS5 already provides BM25; a separate lexical scorer is unnecessary. [Official SQLite FTS5 documentation](https://www.sqlite.org/fts5.html#the_bm25_function)

## AGENTS.md discussion proposals, not automatic edits

| Rule location | Assessment and evidence | Proposed discussion |
| --- | --- | --- |
| 425-429: six mandatory retrieval signals | Prescribes implementation, but fuzzy has measured functional value | Put algorithms in a revisable ADR; retain Profile isolation, no content egress, event-loop boundaries and approved quality gates in AGENTS. Retain current algorithms until gates are agreed |
| 334-339: fixed priority, cross-Profile round-robin, adapter-local retries | No cross-Profile work queue was found; execution uses independent Workers. Outbox also owns durable retries. Wording obscures responsibilities, and same-Profile delivery independence fails a probe | Define Worker control-response objectives and executable cross-account nonblocking checks. Adapters interpret provider restrictions; Outbox persists next delivery times. Avoid adding a central scheduler solely to satisfy round-robin wording |
| 320-331: independent conversations and one FIFO | Finite configured caps expose a fairness/global-order tradeoff, not an inherent contradiction | Document head-of-line blocking if strict FIFO remains. Otherwise amend ADR 0052 while preserving same-Thread order, aggregate capacity, TTL and no outage backlog |
| 517-531: live QQ acceptance at each development stage | Necessary for deployed behavior, but offline research variants and implementation candidates are not distinguished | Clarify that isolated snapshots with synthetic data and no service connection are research. Actual implementation/integration affecting QQ still completes live acceptance; unit tests do not replace it |
| 17-31: repository bootstrap/cutover | Conditional historical rules, not evidence that the current origin is prohibited | Retain independent history/license boundaries; link completed bootstrap details as historical guidance |
| 558-568 and related architecture docs | AGENTS permits the restricted Dashboard; ADR 0053 explicitly supersedes ADR 0041's deferral. This is not an internal AGENTS contradiction | Correct documentation drift: `docs/architecture.md:24-25` still says no HTTP/web administration service. Mark the superseded portion of ADR 0041 |

Draft rules for individual discussion:

> Ablation research may run on an isolated source snapshot at a fixed commit using synthetic data. Change one factor at a time and retain the baseline, behavior tests, quality metrics and costs. Research results must not claim deployment or live Channel acceptance. Actual integration remains subject to the applicable platform and Channel acceptance requirements.

> Retrieval must meet approved relevance, historical coverage, no-match behavior and resource budgets. Record signals and ranking strategies in an ADR and revise them using ablation evidence. Profile isolation, no external content disclosure and keeping synchronous storage off the Channel event loop remain mandatory.

> Profiles execute independently without a central per-work round-robin requirement. A provider wait for one Channel Account must not serially block another account's ready delivery. Preserve segment order within a Logical Result. Adapters supply provider semantics and retry hints; Outbox retains durable retries and receipt correlation.

The user selected discussion of design constrained by verifiable outcomes. This confirms the discussion direction, not approval of specific rule changes. Retrieval quality/resource gates, the precise scope of delivery fairness and whether finite-cap admission retains strict Profile-wide FIFO remain open. None of these drafts changes the effective rules.

## Retained boundaries and next experiments

Retain one Supervisor, separate Worker/App Server per Profile, stdio, the asynchronous SQLite Worker, durable correlation/Outbox, original approval-request association, control-plane authorization, and migration/backup/audit boundaries. They address lifecycle, trust, recovery or blocking isolation; one implementation does not make them redundant. Historical migrations cannot be deleted merely because they are large.

There is no evidence supporting removal of the seven current production third-party dependencies or collapsing 12 packages into a single large module. Native protocol calls in `TurnCoordinator`, routing/durable commits in `ConversationTurnCoordinator`, and notification correlation in `CodexEventRouter` have different responsibilities and should remain separate for now.

Recommended order: bring A4's failing scenario into formal regression coverage, then review A1/A2 cleanup. Separately test Outbox cross-account blocking, batches filled by one account, segment order, restart and draining. Run retrieval signal ablations on a representative labeled set of Chinese/English, historical, misspelled, exact-value and no-match queries. Passing 250 existing tests is necessary evidence, not proof of complete semantic equivalence.

For each next experiment, predeclare invariants, the single removed factor, counterexamples, pass thresholds and rollback conditions. Reject any isolation/approval/deduplication/recovery regression. Advance performance candidates only after quality gates pass. File or line count must not be the only objective.

## Local evidence and reproduction

Raw logs, JSON, patches and probes are in `/private/tmp/bridge-audit-evidence-2a665ef/`; the source snapshot is `/private/tmp/bridge-audit-2a665ef/`. These are local temporary audit artifacts, not committed release evidence; recreate them if the OS removes the directories.

- `ablation-results.json`: A1/A2/A3 results; corresponding `.patch` and `*-unit.log` files preserve changes and failing tests.
- `behavior-probes.test.mjs`, `baseline-behavior.log`: queue synchronization and cross-account delivery assertions fail on baseline; the strict FIFO blocking reproduction passes.
- `A4-co-located-active-state.patch`, `A4-result.json`, `A4-probe.log`: state consolidation and passing queue assertion.
- `combined-result.json`, `combined-unit.log`, `combined-probe.log`: A1+A2+A4 interaction checks.
- `retrieval-benchmark.mjs`, `baseline-retrieval*.json`, `A3-retrieval*.json`: timing, recall and matching signals for both corpus layouts.
- `run-ablation.py`, `run-state-ablation.py`: local variant runners with fixed paths; target only the isolated snapshot, never the production checkout.

On the restored baseline, `node --test /private/tmp/bridge-audit-evidence-2a665ef/behavior-probes.test.mjs` is expected to exit 1 with two failed assertions. These are the reported counterexamples; do not hide them or change expectations to make the baseline pass. Run `AUDIT_NOISE_AFTER=100 node /private/tmp/bridge-audit-evidence-2a665ef/retrieval-benchmark.mjs` to repeat the baseline with additional irrelevant records.
