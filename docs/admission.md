# Access, commands, and Profile-local admission

## Ordered inbound boundary

Every non-duplicate normalized Channel event reaches one `ChannelIngressController`.
It applies the boundary in this fixed order:

1. evaluate private-chat or layered group Access Policy;
2. retain passive or body-free events in the Message Archive without starting Codex work;
3. parse Bridge Commands once in the core;
4. apply Profile-local ordinary-input admission;
5. start, steer, queue, or explicitly reject the work.

The Adapter supplies only provider facts. The Profile worker supplies Profile,
Channel Account, and Account Epoch authority before this boundary. Rejected and
passive events remain archive evidence, not an outage backlog.

## Commands

The parser recognizes `/help`, `/status`, `/new`, `/attach THREAD_ID`, `/detach`,
`/stop`, `/approve TOKEN DECISION`, `/model MODEL_ID`, and `/reasoning EFFORT`. `//text` escapes a leading
slash and becomes ordinary Codex input. Unknown commands and wrong argument
counts are explicit invalid-command dispositions and are never passed to Codex.

`/stop` calls native `turn/interrupt` with both the active Thread and Turn IDs,
and only the Provider Identity that initiated that Turn may invoke it.
`/approve` answers an exact pending native Approval Request after the same
initiator check. `/help` and `/status` are local read-only projections.
`/new`, `/attach`, and `/detach` change only the Bridge-owned Thread Binding;
`/attach` rejects a native Thread whose resolved working directory differs from
the Profile Workspace. `/model` and `/reasoning` validate the native model
catalog and call the optional native `thread/settings/update` method. Missing
native capability is reported as unsupported rather than emulated. Shared
conversation-scoped group settings require host-local Profile Administrator
control; private and participant-scoped group bindings can use these commands.

## Steer mode

Steer is the default. When the same Thread Binding has an active native Turn,
new ordinary input calls App Server `turn/steer` with its exact Thread ID and
`expectedTurnId`. It does not consume another active-Turn slot. Input acceptance
is persisted before the native request, and the correlation is terminalized with
the active Turn. An ambiguous outcome is marked `uncertain` and is not replayed.

In `0.2.0-rc.1`, independent Threads have no Profile concurrency cap by default:
`admission.maximumActiveTurns: null`. Private and group work can overlap.
Operators may explicitly set a finite cap; only then can another Thread consume
the last slot and cause `busy`. Steer mode does not silently form a queue.
An active same-Thread Turn without a steerable initiator/target can still cause
`busy`; removing the Profile cap does not bypass Thread control.

## Queue mode

Queue mode uses one bounded queue only while the Profile is ready. It rejects the
newest input as `busy` when full, expires old entries without executing them, and
surfaces each expiry. In Next, releasing an active slot starts the oldest
eligible entry, skipping work whose Thread is still active. FIFO holds within a
Thread Binding; strict Profile-wide FIFO is not promised.

Next, verified by [live QQ acceptance](acceptance/capability-and-admission-20260905.md): promoted queued work is registered as active
before execution. Its Channel context and native Turn target share one active
record, so approval-controller lookup and account quiescence checks retain the
same work until release, including during a drain. Existing Turn Initiator
checks remain; independent Threads follow the eligibility rule above.

The rate window is per Channel Account. Admission state is deliberately
Profile-local and in memory: accepted Codex correlation, Thread Binding, archive,
and delivery state are durable, while queued ordinary input is not accepted
Codex work and is discarded explicitly when the Profile becomes unavailable.
