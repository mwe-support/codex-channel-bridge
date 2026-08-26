# Codex Channel Bridge

This context describes how people use external messaging channels to start,
continue, and control Codex work without an intervening agent gateway.

## Language

**Channel**:
An external messaging service through which a person communicates with Codex, initially QQ or WhatsApp.
_Avoid_: Platform, gateway

**Channel Conversation**:
A provider-scoped private chat, group, or other conversation route that can be associated with Codex work.
_Avoid_: Session, channel session, chat session

**Conversation Key**:
The stable, Profile-scoped routing identity for one Channel Conversation.
_Avoid_: Session key, project name, Codex Thread ID

**Channel Participant**:
A provider-authenticated person who sends a message or acts on an interactive prompt in a Channel Conversation.
_Avoid_: Account, operator, session user

**Provider Identity**:
The stable participant identifier asserted by one Channel provider; identities from different providers remain distinct even when they represent the same person.
_Avoid_: Global user, cross-channel account

**Channel Account**:
A provider-side bot or login identity through which a Profile receives and sends Channel messages.
_Avoid_: Profile, Channel, participant account

**Channel Account Epoch**:
The Profile-scoped period of one Channel Account binding, beginning at an explicit cutover boundary and excluding provider events from earlier bindings.
_Avoid_: Login session, credential version, Message Archive partition

**Secret Reference**:
A configuration value that resolves a secret from the process environment, the Profile's owner-only `secrets.env`, or an explicit owner-only single-value file without embedding it in `config.yaml`.
_Avoid_: Password field, raw secret value, Baileys auth-state record

**Configuration Revision**:
The complete, statically validated Bridge configuration accepted by an explicit administrator apply operation and used as the desired state for independently transitioning Profiles.
_Avoid_: Config file contents, partial Profile update, automatic reload event

**Channel Binding**:
The ownership relationship that assigns one Channel Account to exactly one Profile.
_Avoid_: Channel configuration, connector profile

**Passive Context Event**:
An inbound group event retained as limited conversation context but not permitted to start a Codex Turn.
_Avoid_: Background turn, ignored message

**Access Policy**:
A Profile-configured `deny`, `allowlist`, or `open` rule applied separately to private identities, group conversations, and participants inside admitted groups.
_Avoid_: Permission profile, Codex approval policy

**Admission Control**:
The Profile-local decision to accept, steer, queue, expire, or reject Codex work under configured concurrency, queue, rate, and storage bounds.
_Avoid_: Access Policy, provider retry, OS resource isolation

**Message Archive**:
The permanent, Profile-owned record of Channel events observable to its bound Channel Accounts, retained until explicitly deleted.
_Avoid_: Transcript, recent context, Codex history

**Archive Purge**:
An explicit administrator deletion of either one Profile's entire Message Archive or records in one exact Channel Conversation older than a chosen time, without altering Codex history or Thread Bindings.
_Avoid_: Retention policy, Profile purge, Codex history deletion

**Retrieved Context**:
A bounded selection of recent or explicitly retrieved Message Archive records supplied to a Codex Turn.
_Avoid_: Full archive, conversation history

**Local Hybrid Retrieval**:
Profile-local retrieval that fuses exact identity/value matches, FTS5 BM25, substring matches, fuzzy text similarity, structured filters, and recency without an embedding model or external content disclosure.
_Avoid_: Semantic search, vector search, external retrieval service

**Context Projection**:
The bounded act of supplying Codex with Channel-only Message Archive records that have not already entered the target Codex Thread.
_Avoid_: History synchronization, Thread compaction, transcript copy

**Codex Channel Bridge**:
The standalone system that connects Channel Conversations directly to Codex App Server while retaining channel-neutral routing and control semantics.
_Avoid_: Hermes gateway, agent gateway, bot gateway

**Profile**:
A logical security and ownership boundary within one Codex Channel Bridge deployment that owns its Channel Bindings; participants in different Profiles are mutually untrusted at the application layer.
_Avoid_: Tenant label, bot configuration, channel account

**Profile Tombstone**:
The permanently retained, body-free marker that prevents a purged Profile identity from being reused or confused with historical audit, backup, and delivery records.
_Avoid_: Disabled Profile, Profile backup, deleted Profile data

**Bridge State**:
The Profile-owned routing, correlation, archive, approval-transport, and delivery records required to recover Channel communication without copying Codex history.
_Avoid_: Session state, Codex history, transcript

**Audit Record**:
A durable, body-free record of a security-relevant Bridge action, its internal actor and target references, outcome, time, and correlation identity.
_Avoid_: Operational log, message history, audit log line

**Support Bundle**:
An explicitly created, content-free diagnostic artifact containing allowlisted Bridge metadata for an administrator to inspect or share outside the Bridge.
_Avoid_: Log archive, Profile export, automatic crash report

**Workspace**:
The single approved project filesystem scope assigned exclusively to one Profile.
_Avoid_: Working directory, repository path, project alias

**System Administrator**:
The host-level authority that creates, disables, and constrains Profiles.
_Avoid_: Profile owner, super participant

**Profile Administrator**:
A person authorized to manage one Profile's Channel Bindings, workspaces, and membership.
_Avoid_: System Administrator, group owner

**Profile Health**:
The readiness of one Profile to accept Codex work, expressed as `starting`, `ready`, `degraded`, `unavailable`, `draining`, or `stopped` with a stable reason.
_Avoid_: Supervisor liveness, deployment health, process existence

**Participant**:
A Channel Participant authorized to use Codex within a Profile.
_Avoid_: Member, user, operator

**Codex Thread**:
A persisted Codex conversation containing the work history shared across its turns.
_Avoid_: Channel Conversation, project, session

**Thread Binding**:
The durable association that lets a Channel Conversation continue work in a particular Codex Thread.
_Avoid_: Session mapping, conversation cache

**Group Thread Scope**:
A Channel Binding rule that chooses whether a group uses one Thread Binding for the whole Channel Conversation (`conversation`) or a distinct Thread Binding for each Provider Identity in that group (`participant`).
_Avoid_: Group session mode, multi-user Thread

**Thread Controller**:
The single client currently authorized to start, steer, or interrupt work in a Codex Thread.
_Avoid_: Thread owner, writer process

**Control Lease**:
The explicit, exclusive authority held by a Thread Controller until it detaches or an administrator revokes control.
_Avoid_: Attach state, timeout lock

**Codex Turn**:
One user request and the Codex work that follows within a Codex Thread.
_Avoid_: Job, task, message

**Logical Result**:
The single terminal Channel outcome for a Codex Turn, identified independently from any provider message or output segment used to deliver it.
_Avoid_: Final message, provider receipt, output chunk

**Turn Initiator**:
The Provider Identity whose accepted input started a particular Codex Turn and therefore holds its participant-level steer, stop, approval, and user-input authority while that Turn is active.
_Avoid_: Thread owner, group administrator, approver

**Approval Request**:
A Codex-originated request for an authorized Channel Participant to allow, limit, or deny a proposed action for a specific Codex Turn.
_Avoid_: Confirmation message, approval turn

**Reviewer**:
The Codex-owned policy mechanism that either resolves an approval automatically or sends an Approval Request to the controlling client.
_Avoid_: Bridge approval mode, Channel administrator

**Channel Presentation Policy**:
A configurable projection that selects which Codex events are rendered into a Channel and at what detail, without changing the underlying Codex Turn, items, or history.
_Avoid_: Codex event filter, logging level, reasoning policy

**Channel Detail Level**:
The `compact`, `progress`, or `detailed` selection within a Channel Presentation Policy; a Participant may select a level only up to the maximum allowed by the Profile Administrator.
_Avoid_: Debug mode, Codex verbosity, reasoning effort

**Bridge Command**:
A Channel command that either changes Bridge-owned routing or delivery state, or invokes one exact Codex-native operation without duplicating its settings or policy.
_Avoid_: Bot feature, agent command, custom Codex setting

**Archive MCP Server**:
A Profile-local, read-constrained MCP server through which Codex can search and retrieve that Profile's Message Archive using Codex's native tool lifecycle.
_Avoid_: Archive agent, global search service, Bridge tool runtime
