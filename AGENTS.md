# AGENTS.md

This file is the authoritative agent instruction set for the standalone
project. Any `AGENTS.md` inherited from the Hermes repository or preserved in
historical material is reference-only and does not constrain this project.

## Repository Purpose

This repository is a standalone, self-hosted Codex Channel Bridge. It connects
external QQ and WhatsApp conversations directly to Codex App Server without a
Hermes, OpenClaw, or other agent-gateway runtime dependency.

Legacy Hermes plugins and documents inherited with the exploratory worktree are
reference material only. New runtime code must not import them or preserve their
plugin lifecycle as architecture.

## Repository Lineage

This project must have a new Git history with no inherited Hermes commits,
branches, tags, remotes, CI, or release metadata. Until the repository cutover
is complete, never stage, commit, publish, or push from the linked exploratory
worktree. Read `docs/repository-cutover.md` before repository bootstrap, the
initial commit, or any operation that changes the current `.git` link.

The initial repository may retain only this project's authoritative design and
research files plus a newly written README, Apache-2.0 LICENSE, NOTICE,
`.gitignore`, and new implementation. Exclude inherited `plugins/`, `deploy/`,
`mcp/`, scripts, and Hermes operations or architecture documents. Consult those
files only in the original Hermes repository. Any later source reuse requires a
file-by-file license check and attribution in NOTICE; prior presence in this
worktree is not reuse authorization. Initialize branch `main` and leave remotes
empty until the user provides the new repository destination.

## Codex-Native First

The Bridge only adapts external Channel messages to and from Codex. Codex owns
the agent.

Before designing or implementing any behavior:

1. Classify the behavior as Channel-owned, Bridge-owned, or Codex-owned.
2. For Codex-owned behavior, read the current official Codex App Server
   documentation, generated schema, and relevant upstream source.
3. Use Codex's native protocol method or setting when one exists. Keep the
   decision, state, and policy inside Codex.
4. Add Bridge behavior only for an external Channel contract, Profile routing,
   durable delivery, or another boundary Codex does not own.
5. Document the external constraint and the native Codex mechanism the Bridge
   projects into.

Do not recreate Codex Thread history, Turn lifecycle, context compaction,
Reviewer policy, sandbox/permission policy, model selection, skills, tools,
MCP configuration, or account behavior in the Bridge. A compatibility shim is
acceptable only for a pinned Codex version, with a removal condition and a
contract test against that version's generated schema.

Declare a minimum supported Codex CLI version and maintain an explicit tested
version matrix. At Profile-worker startup, initialize App Server and probe the
actual protocol capabilities required by that Profile; never infer support from
the version string alone. A missing or incompatible stable capability required
for correctness keeps the affected Profile unavailable and fails closed.
Missing experimental capabilities disable only their dependent enhancements,
emit a clear degraded-capability status, and must not be emulated in the
Bridge. A version above the tested matrix may run only when stable capability
probes pass, and must be reported as unverified rather than silently treated as
supported.

The Bridge, its native installers, and its running services must never install,
upgrade, downgrade, or otherwise mutate the host's Codex CLI. A host
administrator supplies the Codex executable, explicitly or through the service
environment, and owns every native Codex upgrade. If it is absent or
incompatible, keep the affected Profile unavailable and report an actionable
diagnostic without running package managers or download scripts. Linux Docker
images may include an explicitly pinned, tested Codex CLI at image build time;
the running container must not self-update it.

Channel commands for model and reasoning selection must project into native
App Server model discovery and Thread settings. Do not hard-code Codex model or
reasoning-effort catalogs, modify Profile-wide Codex configuration as a Thread
setting, or persist a competing Bridge-side selection.

## Ownership Boundaries

Codex App Server is authoritative for:

- Codex Threads, Turns, items, history, and compaction;
- Reviewer decisions and Approval Request schemas;
- sandbox, permissions, models, tools, skills, MCP, and Codex configuration;
- Codex authentication within each Profile's isolated Codex home.

The Bridge is authoritative for:

- Profiles, Channel Accounts, Channel Bindings, and Access Policies;
- provider-event normalization and Provider Identity;
- Channel Conversation to Codex Thread routing identifiers;
- inbound deduplication, active delivery correlation, durable outbox, retries,
  and provider receipts;
- presenting unresolved Codex Approval Requests to the controlling Channel
  Participant and returning the response to the original App Server request;
- the Profile-owned Message Archive and bounded projection of Channel-only
  context that Codex has not already received.

Channel providers are authoritative for provider message identifiers, delivery
responses, participant identifiers, and the events they expose to the Bridge.

## Profile Boundary

One Bridge deployment may host multiple mutually untrusted Profiles. Each
Profile has a separate worker, Codex App Server process, Codex home, Workspace,
state database, media directory, and one or more exclusively owned Channel
Accounts. The default shared-OS-user deployment is application-layer isolation,
not hostile-process isolation; describe it accurately.

Treat Profile disablement and Profile purge as separate operations. Removing a
Profile from the active configuration or setting it `disabled` performs a
bounded drain and stops its worker while preserving all Profile data, Channel
authentication, and Channel Bindings for later re-enablement. A disabled
Profile's Channel Account must not be rebound to another Profile implicitly.

Purge only through an explicit host-local `bridge profile purge <profile-id>`
operation. Require the Profile to be disabled with no live work: no active Turn,
queued input, pending Approval Request, pending user-input request, or pending
outbox delivery. Preview the record counts and exact Bridge-owned paths, and
require confirmation using the complete Profile ID. Purge may delete only
Bridge-owned state, Message Archive, media, and locally held Channel
authentication; it must list but preserve the Workspace and Codex home and must
not modify Codex internal files. Never reuse a purged Profile ID. Retain a
body-free Profile Tombstone and Audit Record so historical audit, backup, and
delivery identities cannot collide with a future Profile.

Each Profile worker must spawn and supervise its own App Server child from the
administrator-supplied Codex executable. Never connect two Profiles to one App
Server process, and do not support attaching a Profile to an administrator-run
shared or remote App Server in the first release. App Server restart,
capability negotiation, authentication state, Codex home, and Workspace
environment remain Profile-local.

Use App Server's local stdio transport and newline-delimited JSON exclusively
in the first release. Treat child stdout as protocol-only: any non-protocol
stdout is a protocol fault, never an operator log. Capture stderr separately as
bounded, redacted diagnostics. Do not open TCP/WebSocket listeners or add Unix
socket and named-pipe variants without a later ADR covering authentication,
lifecycle, and cross-platform consequences.

Within a Profile worker, supervise each Channel Account adapter independently.
An adapter connection failure must not stop the Profile's other adapters or its
Codex App Server. The first release does not promise process isolation between
Channel Accounts in the same Profile.

Environment variables override `config.yaml`. Invalid or incomplete access
configuration fails closed. Credentials, tokens, provider identifiers, auth
state, and local Profile data must never be committed or logged.

Keep credentials out of `config.yaml`; configuration may contain only Secret
References. Resolve `env:NAME` first from the actual process environment and
then from that Profile's persistent `secrets.env`; support
`file:/absolute/path` for one-secret files such as Docker Secrets. Never search
the Workspace, current directory, or repository for `.env` files. Read only the
Profile's fixed or explicitly configured absolute `secrets.env` path. Parse
ordinary `KEY=VALUE` dotenv records without shell execution, command
substitution, variable expansion, or file inclusion.

Require `secrets.env` and `file:` targets to be regular, non-symlink files. On
macOS, Linux, and Docker require service-user ownership and permissions no wider
than `0600`; on Windows require an ACL limited to the service identity and
explicitly authorized administrators. Missing, empty, malformed, or insecure
secret input fails the affected Profile closed. Allow a System Administrator to
edit the file safely or use an authenticated, no-echo `bridge secret set`
operation with stdin, `--from-env`, or `--from-file`; never accept a secret
value as a CLI argument. Lock and atomically replace `secrets.env` using a
temporary file, flush, and rename.

`secrets.env` is plaintext persistence protected by filesystem permissions, not
application encryption. Reload it on Profile worker start and explicit
configuration apply, list it as sensitive material in the backup manifest, and
exclude names and values from logs, Audit Records, Support Bundles, and Channel
output. Persist rotating Baileys authentication separately within its Profile
boundary; it is not a Secret Reference. A future platform credential-store or
master-key backend requires its own ADR.

Apply configuration only through explicit System Administrator actions; the
first release must not watch `config.yaml` for automatic reload. `bridge config
check` validates the candidate without changing runtime state, and `bridge
config apply` rereads `config.yaml` plus environment variables, reports the
redacted diff, affected Profiles, and required drain/restart actions, then asks
for explicit confirmation. Parse and statically validate the complete candidate
before accepting it; any error rejects the whole candidate and preserves the
current Configuration Revision. Show a changed secret only as `changed`, never
its old or new value.

After accepting a new Configuration Revision, transition affected Profiles
independently. A runtime startup failure makes only that Profile unavailable and
must not roll back or stop healthy Profiles. Live-apply only settings with an
explicit safe contract. Changes to Workspace, Codex home, Channel Account, or
App Server environment require that Profile's bounded drain and restart; do not
promise universal hot reload.

## Channel Contracts

- QQ uses Tencent's official QQ Bot SDK and APIs.
- WhatsApp uses Baileys and must persist its authentication state safely.
- Keep Channel adapters behind one channel-neutral contract. The first release
  ships in-tree adapters; it does not introduce a dynamic plugin runtime.
- Private-chat and group-chat Access Policies are distinct and use only
  provider-stable identities.
- Preserve platform-specific delivery semantics inside the adapter; expose
  normalized events and receipts to the Bridge core.
- Parse Bridge Commands once in the core. Adapters must not invent divergent
  command names, escaping, authorization, or argument semantics.

Keep each Channel Account exclusively bound to one Profile across the entire
deployment. Cross-Profile reassignment is an explicit System Administrator
operation, never an effect of ordinary configuration reload. Require the source
Profile to be disabled with no active Turn, pending Approval Request, or pending
outbox delivery. Reassignment starts a new Channel Account Epoch at a recorded
cutover boundary; the target may process only post-cutover provider events so a
provider replay cannot start Codex work from the old epoch.

Treat reassignment as a fresh binding, not Profile migration. Preserve the
source Profile's Message Archive, media, Access Policies, Conversation and
Thread Bindings, and Codex history in the source boundary, and transfer none of
them to the target. Require new target Secret References and require WhatsApp
to pair again; never copy QQ credentials or Baileys authentication state across
Profiles automatically. After cutover, the source retains its historical epoch
but cannot send or receive through the account. Record body-free Audit Records
for both Profiles. If cutover fails, leave the account unbound rather than
silently restoring it to the source. A future history-and-credential migration
protocol requires a separate ADR and security review.

Provision QQ credentials only as System Administrator-controlled Secret
References; allow no-echo entry only through the authenticated host-local secret
operation, and never accept values in CLI arguments, Channel messages, or
plaintext `config.yaml`. Allow an authorized Profile Administrator to start
WhatsApp pairing only through the authenticated host-local control plane.
Return an expiring QR code or pairing code only to the initiating interactive
CLI and never persist it in logs, databases, Message Archive, Audit Records, or
diagnostic artifacts.

Stage new Baileys authentication separately and atomically replace active state
only after a successful provider connection proves the same Provider Identity
as the existing Channel Account. On identity mismatch, timeout, interruption,
or validation failure, delete the staged state and preserve the last valid
state; a different Provider Identity requires a new Channel Account and cannot
overwrite the old account's history. Credential rotation or reauthentication of
the same account restarts only that Channel adapter, not the Profile worker or
App Server. Its body-free Audit Record may contain internal references, actor,
action, and result, but no QR or pairing code, secret value, Secret Reference
value, or raw Provider Identity.

Separate reversible adapter disconnection from destructive authentication
revocation. `disconnect` stops only the Channel adapter and preserves its
Channel Binding and authentication state. An authorized Profile Administrator
may request `logout` or `revoke` only through the host-local control plane after
the affected account is bounded-drained with no active Turn, pending Approval
Request, or pending outbox delivery.

For WhatsApp, request provider logout first and delete local Baileys
authentication atomically only after explicit provider confirmation. An
uncertain result sets reason `auth_revoke_uncertain`, keeps the adapter stopped,
and disables automatic reconnect until an administrator retries logout or
explicitly chooses `forget-local`. The latter deletes only local authentication
and must state that remote invalidation is unproven. For QQ, support disconnect
but never claim to revoke Tencent developer credentials: direct the
administrator to revoke or rotate them in the official console, then require a
System Administrator to update the Secret Reference. None of these operations
deletes Message Archive, media, Conversation or Thread Bindings, Codex Threads,
or Workspace contents. Audit only internal references, action, result, and
whether remote revocation was confirmed.

Before changing Channel behavior, read the official platform contract when one
exists and the exact SDK source/version used by the repository.

## Persistence and Delivery

Codex history is not copied into Bridge storage. Persist only Bridge-owned
routing, correlation, approval transport, Message Archive, and delivery state.
Target effectively-once final delivery through unique provider event IDs,
Codex input correlation, a durable outbox, logical result IDs, and restart
reconciliation. Never claim strict exactly-once behavior when the provider
offers no idempotent send contract.

After App Server failure, resume Codex-owned Thread state and reconcile before
replaying input. Never reuse a server request identifier from the failed
process, silently replay an uncertain Turn, or replace Codex-restored Thread
settings with Bridge defaults.

Restart a failed or protocol-corrupt App Server child with bounded exponential
backoff and jitter. Repeated failures open a Profile-local circuit breaker
instead of creating an infinite restart loop; recovery requires a configured
cooldown with successful capability negotiation or an administrator action.
While the circuit is open, reject new Codex Turn work for that Profile but keep
its Channel adapters available for status and continue delivering already
committed outbox records. Close pending process-scoped requests as failed, then
resume and reconcile Codex-owned state after restart without blindly replaying
uncertain input.

An unavailable Profile still applies Access Policy, inbound deduplication, and
Message Archive retention to observable Channel events. Local read-only Bridge
commands such as help and status may continue, but input that would start,
steer, interrupt, or queue Codex work must receive an explicit unavailable
response. Do not create an outage backlog or automatically execute rejected
input after recovery; archive retention is evidence, not acceptance for later
execution.

Apply simple Profile-local Admission Control before starting Codex work. Each
Profile has configurable maximum active Turns, one bounded FIFO for explicit
queue mode, a maximum queue age, and a simple per-Channel-Account admission
rate. Steer mode does not create an ordinary-message queue. Queueing is allowed
only while the Profile is ready; it is not an outage backlog. When the FIFO is
full, reject the newest input with an explicit `busy` response. Expire stale
entries without execution and report expiry to the Channel; their Message
Archive records remain historical evidence only.

Use fixed work-class priority—Approval and user-input responses, committed
outbox delivery, active-Turn control, then new Turns—and a simple round-robin
scan across Profiles. Do not build a general scheduler, broker, hierarchical
quota system, or distributed queue in the first release. Keep provider retry
and rate-limit backoff inside each adapter using provider hints plus bounded
jitter, so one Channel or Profile cannot block another.

Configure a deployment disk-safety floor and retain existing per-attachment and
per-Profile media limits. Under storage pressure, reject new Codex work and stop
media mirroring first. If a Channel event can no longer be committed safely,
disconnect the affected adapters and mark the Profile `unavailable` with reason
`storage_pressure`; never acknowledge persistence that did not occur. The first
release provides application-level admission fairness only, not CPU or memory
security isolation. Deployments needing hard resource isolation must use
separate OS users, containers, or cgroups outside the Bridge. Record only
internal references, counts, and stable reason codes for rejection, expiry,
rate limiting, and storage pressure.

On an intentional Bridge stop, restart, or upgrade, enter a bounded drain state
before terminating children. Reject new Turn, steer, and queue input, while
still accepting Approval and user-input responses required by an already active
Turn. Allow active Turns to complete and commit their outbox records until the
administrator-configured drain timeout; then invoke native `turn/interrupt`,
terminate App Server gracefully, and use forced termination only after a
separate child-exit timeout. Flush Bridge state and treat any unresolved Turn as
uncertain for restart reconciliation rather than assuming success or failure.

Keep backup media and scheduling operator-owned. Host-local backup coordination
may drain and stop a named Profile, checkpoint its SQLite database, flush its
outbox, and emit a versioned manifest identifying the Bridge-owned data, full
Codex home, optional Workspace, and external credential material that the
operator must snapshot. The Bridge must not copy, parse, convert, or repackage
Codex-owned history or Workspace contents. Resume only through an explicit
backup-finish action, validate a restored set before starting its worker, and do
not claim a cross-domain online hot backup in the first release.

Do not promise cross-operating-system or arbitrary-path restore in the first
release. A supported restore retains the Profile ID, operating-system family,
Codex home path, Workspace absolute path, compatible Codex version, ownership,
permissions, and separately restored credentials. Same-platform host migration
is allowed when those invariants are recreated; Docker migration preserves the
same paths inside the container. Never rewrite Codex rollout JSONL, private
SQLite tables, Thread IDs, or persisted cwd values to manufacture portability.

Keep Bridge installation and version selection operator-owned; the running
Bridge must never download, install, or upgrade itself. A normal service start
must not execute an irreversible database migration. When a binary finds an
older Bridge schema, keep the Supervisor live and mark each affected Profile
`unavailable` with reason `migration_required` until a System Administrator
performs an explicit migration.

`bridge migrate plan` must report the version span, affected Profiles,
operations, estimated disk requirement, and every irreversible step without
changing state. `bridge migrate apply` requires each target Profile to complete
a bounded drain, a completed backup manifest plus explicit operator
confirmation that the prepared data was snapshotted, and confirmation of the
plan. Migrate each Profile's SQLite database independently and verify and audit
each schema step. A failure leaves that Profile unavailable and must not modify,
start, or stop sibling Profiles. Migration code may touch only Bridge-owned
state; it must not read or modify Codex home, Codex databases, rollout JSONL, or
Workspace contents.

Do not provide automatic down migrations. Direct binary downgrade is supported
only when its release metadata explicitly declares the current Bridge schema
compatible; otherwise rollback means stopping the new version, restoring the
pre-migration snapshot, and starting the old version.

Archive observable Channel messages until explicit deletion. Keep automatic
prompt projection bounded and avoid reinjecting messages already present in a
Codex Thread. QQ media defaults to metadata/link persistence with optional
mirroring; Baileys media is mirrored when decrypted bytes are first available.

Run Archive Purge only through the host-local administration CLI; Channel
commands cannot delete archive content. A Profile Administrator may purge only
its Profile, while a System Administrator may select any Profile. The first
release supports exactly two scopes: the entire Message Archive of one Profile,
or records in one exact Channel Conversation older than a specified timestamp.
Do not implement arbitrary-query, fuzzy-keyword, cross-Profile, or automatic
retention deletion.

Before purge, show the exact scope, time range, message count, referenced media
bytes, and any live references, then require confirmation using both the Profile
ID and expected count. Reject the whole operation if selected records are
referenced by an active Turn, queue entry, Approval Request, or pending outbox
record. Delete base archive rows and FTS entries in one transaction and reclaim
content-addressed media only when no remaining record references its hash.
Preserve Conversation and Thread Bindings and never alter Codex history. State
explicitly that Bridge archive deletion does not erase content already supplied
to Codex. Append a body-free Audit Record containing actor, scope, count, and a
digest of the deleted set.

Use one WAL-mode SQLite database per Profile with FTS5 as a required capability.
The first release's Local Hybrid Retrieval combines exact, BM25, substring,
fuzzy, structured, and recency signals locally; it does not require embeddings,
a vector extension, or an external Embedding Provider. Run synchronous storage
and retrieval work outside the Channel event loop.

Bound media mirroring by configured per-attachment and per-Profile limits,
stream and hash bytes, derive storage paths from content hashes, and enforce URL
safety before restore. Exceeding a limit retains metadata but must not be
reported as durable byte storage. Never execute an attachment automatically.

When a provider send outcome is ambiguous and cannot be reconciled, retry for
delivery using the same Logical Result and disclose the resulting small
duplicate window. Oversized terminal results remain one Logical Result and use
a summary plus attachment or indexed fallback segments; never silently truncate
the result.

## Observability

Emit structured JSON operational logs from the Supervisor for collection by
launchd, journald, the Windows service adapter, or Docker. The Bridge does not
rotate platform logs. Log internal correlation identifiers, event codes,
states, durations, counts, and version/capability facts, but never Channel
message bodies, Codex input or output, reasoning, media content, signed URLs,
credentials, auth state, or raw provider identities. Apply the same boundary to
captured App Server stderr.

Outbound telemetry is disabled by default. Any future OpenTelemetry export must
be explicitly enabled, use an allowlisted content-free schema, preserve Profile
isolation, and document its destination and disablement. Do not add implicit
crash reporting, analytics, or external logging to a self-hosted deployment.

Keep `bridge doctor` read-only. It may validate configuration, directory
permissions, disk capacity, SQLite integrity with `quick_check`, Codex version
and capabilities, and Profile or adapter health, but it must not repair,
restart, migrate, or otherwise change runtime state.

Create a Support Bundle only through an explicit host-local administrator
command. A Profile Administrator is limited to its Profile; only a System
Administrator may select all Profiles. Before creation, show the selected
Profiles, time range, allowlisted fields, estimated size, and explicit output
path. Write owner-only files containing Bridge and platform versions, schema
versions, capability results, reason codes, state transitions, counts,
durations, migration history, SQLite integrity results, and a redacted
configuration shape. Include a machine-readable manifest and file digests, but
do not claim tamper resistance.

Never include Channel or command bodies, Codex input/output/reasoning, Codex
home or Workspace content, media, authentication state, Secret Reference names
or values, pairing material, raw provider identities, signed URLs, or complete
local paths in a Support Bundle. The first release has no content-inclusion
override. Never upload a bundle automatically or configure a vendor endpoint;
sharing is an external administrator action. Audit bundle creation and export
without recording its contents.

Persist Audit Records separately from operational logs and Message Archive
content. Record security-relevant administration, role and Access Policy
changes, Channel and Thread Binding changes, approval transport outcomes,
backup/restore/purge operations, and manual circuit-breaker actions using only
internal actor and target references, action, result, time, and correlation ID.
Never store message or command bodies, secrets, or raw provider identities in an
Audit Record. Archive purge does not remove its body-free Audit Records; expose
query and export only through the authorized host-local control plane. A System
Administrator may read system-wide and all Profile records; a Profile
Administrator may read only its Profile records and only when its local OS peer
is authorized. Participants and Channel commands have no audit access. Audit
exports require an explicit destination, an allowlisted schema, and owner-only
file permissions. Retain Audit Records indefinitely by default. Only a System
Administrator may configure or execute audit retention; a Profile Administrator
cannot shorten it. Before deletion, report the exact time range and record count
and require explicit confirmation. Every audit cleanup must append an exempt,
permanently retained, body-free Audit Record containing the actor, deleted range,
record count, and digest. Message Archive purge never triggers audit cleanup. Do
not claim the first release is tamper-proof.

## Supported Targets

Native macOS, native Linux, native Windows, and Linux Docker are first-class
targets. Core domain behavior and acceptance tests must remain equivalent; put
service-manager and filesystem differences behind platform-specific edges.

Install one Bridge Supervisor service per deployment, not one operating-system
service per Profile. The Supervisor owns the configured Profile-worker child
processes, and each worker owns its App Server child; adding or removing a
Profile must not require registering another platform service. Preserve this
supervision hierarchy and ensure a worker failure does not terminate the
Supervisor or sibling Profiles.

Expose separate health contracts for the deployment and for each Profile.
Supervisor liveness means only that the main process, control plane, and event
loop are operating; one unavailable Profile must not fail liveness or trigger a
platform restart of healthy siblings. Report each Profile readiness as
`starting`, `ready`, `degraded`, `unavailable`, `draining`, or `stopped`, with a
stable reason code. Native service managers and the default Docker health check
must use Supervisor liveness. Administrative and deployment checks may target
one Profile or explicitly require all Profiles to be ready. Mark the whole
service unhealthy only for a fatal Supervisor, configuration-loading, or
control-plane failure.

Run the Supervisor as one foreground process. It must not fork into the
background, create a PID file, or attempt to restart itself. Platform packaging
adapts launchd, systemd, Windows Service control, and Docker stop signals into
the same drain-and-exit contract; the platform service manager alone decides
whether to restart the Supervisor. Keep Supervisor restart policy separate from
its internal worker and App Server supervision to prevent nested restart loops.

Expose first-release administration only through a host-local structured IPC
control plane: an owner-only Unix domain socket on macOS, Linux, and Docker, and
a named pipe with a strict Windows ACL. Validate the local peer identity where
the platform supports it, authorize every operation, and never treat loopback
network location as authentication. The CLI uses this control plane for status,
diagnostics, Profile administration, and backup coordination; Docker operators
invoke it inside the container. Do not expose TCP, HTTP, or a Web Administration
Console in the first release. A future Web Administration Console remains in
scope only after a separate ADR defines authentication, authorization, TLS,
browser security, audit, and network exposure.

The first release uses TypeScript on a supported Node.js LTS runtime. Keep core,
Profile worker, QQ adapter, WhatsApp adapter, Archive MCP Server, CLI, and
platform packaging as explicit monorepo package boundaries. Do not introduce a
second core runtime without an accepted ADR demonstrating the need.

## Documentation and Completion

- Use `CONTEXT.md` as the canonical glossary; do not use `session`, `project`,
  `account`, or similar overloaded terms without resolving them to that model.
- Record hard-to-reverse boundary decisions in `docs/adr/`.
- Update the nearest operator and adapter documentation with every behavior or
  configuration change before release.
- Validate protocol handling against the generated schema for the pinned Codex
  version, plus Channel contract tests, Profile-isolation tests, concurrent-chat
  tests, Approval Request round trips, restart recovery, and duplicate-delivery
  regressions relevant to the change.
- Never publish or release with undocumented behavior, unverified rollback, or
  real credentials and identifiers in tracked files.
