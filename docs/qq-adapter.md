# QQ adapter baseline

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
official SDK content sanitizer, then produces one channel-neutral event:

- C2C messages use `user_openid` as both the stable participant and provider
  conversation identity and are marked `direct`.
- Group messages use `group_openid` for the conversation and `member_openid`
  for the participant. `GROUP_AT_MESSAGE_CREATE` is marked `mention`, while
  full-group events are marked `passive`.
- The durable provider-event key encodes the provider message ID together with
  `msg_idx` when present. The Profile Store deduplicates it within the Channel
  Account Epoch before emitting the event to later routing work.
- Provider identifiers remain internal data. Operational output must not log
  them or the message body.

The SDK advances its Gateway resume sequence before awaiting application
commit. This baseline therefore does not configure SDK session persistence and
does not claim crash-safe Gateway acknowledgement. Closing that provider gap
requires a pinned-version contract shim or an upstream post-commit cursor API.

## Text delivery

`sendText` maps a normalized private target to the official C2C route and a
group target to the official group route. A successful provider response
becomes an `accepted` receipt. Definite non-rate-limit 4xx failures are
`rejected`; rate limits, transport failures, and other uncertain outcomes are
`ambiguous`.

This method is sufficient for the controlled live contract only. The official
SDK creates a fresh `msg_seq` for every passive helper call. Production durable
delivery must first persist the chosen `msg_id + msg_seq` pair and use the raw
provider send API. Until the outbox implements that rule, the Bridge does not
claim effectively-once QQ result delivery.

## Verification

Unit contracts cover the exact intent and transport, C2C/group normalization,
mention versus passive attention, accepted/rejected/ambiguous delivery mapping,
and startup failure. Profile Worker contracts cover Secret resolution,
archive-before-routing, independent adapter failure, and drain.

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
