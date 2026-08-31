# Codex Approval Request routing

## Native ownership

Codex Reviewer policy remains authoritative. The Bridge does not decide whether
an operation needs approval and never converts approval text into another Turn.
For each App Server process generation, one `CodexServerRequestRouter` receives
server-originated requests and answers the original JSON-RPC request ID.

The current stable slice supports:

- `item/commandExecution/requestApproval`;
- `item/fileChange/requestApproval`.

It accepts only the simple native decisions `accept`, `acceptForSession`,
`decline`, and `cancel`. Permission-profile approvals, experimental tool
user-input, MCP elicitation, dynamic tool calls, legacy approval methods, and
account requests fail closed until their distinct contracts are implemented.

## Controller binding

An Approval Request must contain the exact `threadId` and `turnId` of an active
Turn. The router obtains its controlling Channel Participant from the
Profile-local active-work registry. The response must repeat the full trusted
Profile, Channel Account, Account Epoch, Conversation, and Provider Identity
context. A different admitted participant cannot answer it.

Request IDs are process-scoped and indexed with their JSON type, so numeric `1`
does not collide with string `"1"`. Duplicate, malformed, unsupported, and
uncontrolled requests receive JSON-RPC errors. Pending entries are cleared on
Profile stop or protocol fault and are never replayed into a restarted process.

## Channel presentation and response

The router assigns an opaque, generation-local token that is distinct from the
App Server request ID. The Profile worker sends a bounded prompt through the
bound Channel Adapter. The initiator replies with exactly one of:

```text
/approve TOKEN accept
/approve TOKEN session
/approve TOKEN decline
/approve TOKEN cancel
```

The core parser maps `session` to native `acceptForSession`. It applies Access
Policy before the command, then the router rechecks the complete trusted
participant context before answering the original request. Commands and file
contents are hidden in the default `minimal` mode. Profile configuration may
select `summary` or `detailed`; every projected field remains bounded.

The response window defaults to five minutes and is configurable per Profile.
Expiry returns native `cancel`. A definite or deferred presentation failure
also cancels immediately. An ambiguous provider send remains pending until the
initiator responds or the timeout expires because the prompt may have arrived.

## Durable transport and generation boundary

The Profile Store commits the bounded Approval prompt, its Approval Request
record, one Logical Result, initial Outbox records, and a body-free requested
Audit Record in one SQLite transaction. Normal delivery leasing, receipt
validation, ambiguous retry, and provider-specific reply identity therefore
apply to Approval presentation as well as terminal results.

Accepted, ambiguous, and rejected presentation outcomes update durable state.
An authorized Channel decision answers the original process-scoped request and
then terminalizes the durable Approval record with another body-free Audit
Record. Timeout sends native `cancel`, expires the record, and rejects any
unsent presentation.

App Server request IDs remain generation-local and are never persisted for
replay. At a protocol fault, stop, or before a replacement generation becomes
ready, every still-pending durable Approval is cancelled with reason
`app_server_generation_lost`, and its unsent Outbox records are rejected. This
retains evidence without presenting a token that can no longer reach Codex.

Audit rows contain only internal Approval references, action, result, and time.
They contain no request parameters, prompt text, provider identity, receipt,
Channel body, or Codex output. Host-local Audit query/export authorization is a
separate administration slice.
