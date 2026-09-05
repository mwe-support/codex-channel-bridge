# QQ adapter baseline

`0.2.0-rc.1` adds opt-in [automatic output-file delivery](output-files.md) using SDK
upload plus a separate durable-sequence media send, for private and group chats.
Recipient download acceptance is pending; this is not a released feature claim.

## Ownership and dependency

`@codex-channel-bridge/qq-adapter` is a Channel-owned edge behind the shared
`ChannelAdapter` interface. It pins Tencent's official
`@tencent-connect/qqbot-nodejs` package to exactly `1.0.4`. The adapter owns QQ
protocol conversion only; it does not own Access Policy, Profile routing,
Codex Threads or Turns, admission, or durable delivery policy.

The complete provider research and source links are in
`docs/research/qq-official-sdk-contract.md`.

## Startup and Profile lifecycle

Each enabled QQ Channel Account creates one SDK client inside its owning
Profile Worker. Credentials are injected only after the Profile-local Secret
Resolver resolves the configured `appId` and `appSecret` references. The SDK
does not discover environment files.

The client uses WebSocket transport, synchronous token prefetch, and only the
`GROUP_AND_C2C_EVENT` intent (`1 << 25`). A content-free logger replaces the
SDK logger because the SDK's debug output may contain provider payload and HTTP
body content. Startup must reach the SDK `ready` or `resumed` event within 30
seconds. A failed or timed-out account is stopped and marks the Profile
`degraded` with reason `channel_adapter_unavailable`; healthy sibling adapters
and the Profile's Codex App Server remain available.

Drain stops every adapter independently before the App Server and Profile Store
are closed. This baseline does not yet implement automatic adapter restart or
an ongoing per-account readiness report after a post-ready connection failure.

## Inbound normalization

The adapter accepts only C2C and QQ group message events. It applies the
official SDK content sanitizer, then produces one channel-neutral provider
event that contains provider facts only:

- C2C messages use `user_openid` as both the stable participant and provider
  conversation identity and are marked `direct`.
- Group messages use `group_openid` for the conversation and `member_openid`
  for the participant. `GROUP_AT_MESSAGE_CREATE` is marked `mention`. The
  official payload's `mentions[].is_you` flag is also authoritative because QQ
  may deliver a desktop-client bot mention through `GROUP_MESSAGE_CREATE`.
  Other full-group events are marked `passive`.
- `0.2.0-rc.1` also removes leading mention markup from provider-confirmed addressed
  group text before core command parsing. This covers opaque IDs missed by SDK
  1.0.4's AppID-only sanitizer; it preserves private/passive text and mid-body
  mentions. Remove this extra normalization if a future pinned SDK handles that
  exact case and the adapter-to-core contract test still passes.
- The durable provider-event key encodes the provider message ID together with
  `msg_idx` when present.
- The event cannot declare its Profile, Channel Account, Account Epoch, or
  Bridge Conversation Key. The owning Profile Worker injects that trusted
  context into the single Inbound Pipeline, which derives the Conversation Key
  and commits the Message Archive before exposing a new event to later routing
  work. Duplicate events are not exposed again.
- Provider identifiers remain internal data. Operational output must not log
  them or the message body.

The pinned SDK advances its Gateway resume sequence before awaiting application
commit. The Adapter therefore installs a narrow pinned-version coordinator at
the SDK middleware and session-persistence seams. It stages the SDK's eager
checkpoint, captures the sequence before middleware can yield, and persists it
to the Profile SQLite database only after the Inbound Pipeline has committed
the Message Archive. Concurrent messages are committed as an ordered prefix:
a later completed archive operation cannot advance Resume beyond an earlier
uncommitted message. Schema 7 stores one session-aware transport checkpoint per
Channel Account. The sequence cannot move backwards within one Gateway Session;
a confirmed replacement Session may start from a lower provider sequence. On
restart, only that durable Session and sequence are supplied to SDK Resume, so
an observed-but-uncommitted event remains replayable and is then deduplicated by
the Archive provider-event key if it had already committed.

This compatibility shim is specific to SDK `1.0.4`. It must be removed when the
official SDK exposes an awaited post-commit cursor interface, and its contract
tests must remain pinned to the installed SDK behavior.

## Text delivery

### `0.2.0-rc.1`: native private-chat answers

The working tree projects Codex `final_answer` item deltas into QQ C2C streaming,
using SDK 1.0.4's authenticated API gateway. Its higher-level stream helper requires
both anchors; this path sends only `msg_id`, as Tencent requires. It sends full
accumulated text with `input_mode=replace`, stable `msg_seq`/stream identity,
increasing indices and `input_state=10` only from a committed terminal Outbox lease.
Successful DONE receipts survive restart and suppress another ordinary final reply.
Approval messages cannot finish an answer stream. QQ groups and WhatsApp retain
complete-result delivery.

Updates coalesce at 500 ms after the first frame, with one request in flight and
a bounded 5,000-character projection. No reasoning, commentary or tool output is
streamed. Short answers may finish before any generation frame is sent. During
thinking/tool execution there may be no answer text yet; this is not a typing
indicator. `remain_msg_len` is recorded as provider metadata, not a writable
capacity budget: real QQ accepted continued frames and DONE while it was zero.
Actual provider failures, rather than this hint, trigger fallback.

Schema 10 stores only delivery metadata and a prefix digest. Uncertain frames,
prefix changes, capacity errors and failed stream sends fall back through the
ordinary durable Outbox; an unreconciled accepted frame/DONE can leave a partial
bubble or cause a duplicate. There is no provider cancellation/reconciliation
promise. Oversized QQ results are segmented without splitting Unicode pairs or
dropping text. No generation frame alone counts as final delivery.

This is included in **`0.2.0-rc.1` / awaiting full acceptance**. Real
private-chat incremental rendering and DONE passed;
remaining boundary coverage is listed in the evidence below.
See [migration requirements](migrations.md) and
[acceptance evidence](acceptance/qq-native-streaming.md).

`sendText` maps a normalized private target to the official C2C route and a
group target to the official group route. A successful provider response
becomes an `accepted` receipt. Definite non-rate-limit 4xx failures are
`rejected`; HTTP 429 is `deferred` so the durable Outbox applies bounded backoff
and jitter. Transport failures and other outcomes where QQ may have accepted
the request remain `ambiguous` and retry with the same Logical Result identity.

Passive delivery requires the Outbox-allocated `providerReplySequence`. The
Adapter passes the persisted `msg_id + msg_seq` through the SDK's explicit
`send`/raw path, so an ambiguous Outbox retry does not consume a fresh reply
slot. A passive delivery without that durable sequence is rejected locally.

If QQ definitely rejects the anchor with documented business code `304103` or
`40034005`, the Adapter retries exactly once without `msg_id`. No other error
activates this proactive fallback. The user may have disabled proactive
messages, so fallback rejection remains a delivery failure rather than a
successful Codex result. Lost responses still cannot be reconciled through a
Provider lookup API, and the Bridge does not claim strict exactly-once result
delivery.

## Verification

Unit contracts cover the exact intent and transport, C2C/group provider-fact
normalization, mention versus passive attention, accepted/rejected/ambiguous
delivery mapping, rate-limit deferral, stable passive sequence forwarding,
narrow expired-anchor
fallback, unrelated-error rejection, and startup failure. Inbound Pipeline and
Profile Worker contracts cover trusted authority injection,
archive-before-routing, deduplication, provider mismatch isolation, independent
adapter failure, durable checkpoint injection, and drain. Checkpoint contracts
also cover restart restore, invalid-session clearing, commit failure, and
out-of-order concurrent archive completion.

An opt-in real test connects the configured robot, waits for one inbound event,
and sends one fixed passive reply:

```sh
BRIDGE_QQ_LIVE_SECRETS_FILE=/absolute/path/to/secrets.env \
npm run test:qq-live
```

The test prints content-free phase and outcome fields only. Its remaining live
acceptance questions include the robot's C2C/group permissions, group sandbox
admission, outbound-IP permission, duplicate behavior, and provider receipt
semantics.

On 2026-08-26, the configured test robot reached Gateway `ready`, received a
full-group message as `group` + `passive`, returned an `accepted` provider
receipt for the fixed reply, and the reply was independently visible in the QQ
desktop client. No credential, provider identity, provider message ID, or user
message body was written to test output. C2C, mention-only group delivery,
Resume, rate-limit, and duplicate/reconciliation behavior remain unverified.

On 2026-08-27, the updated durable-sequence C2C contract reached Gateway
`ready` but received no new C2C event during its 300-second window. It sent no
message and ended with `live_contract_timeout`. This is an incomplete external
interaction, not evidence that the raw-send path passed or failed.
