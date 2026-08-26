# Tencent QQ Bot Node.js SDK and Open Platform Contract

Research date: 2026-08-26

This note evaluates the first-party Tencent Node.js/TypeScript SDK and the QQ
Open Platform contracts needed by the QQ Channel adapter. It uses only Tencent
documentation, Tencent-owned GitHub repositories, and npm registry metadata.
No credentials or local test configuration were inspected.

## Conclusion

`@tencent-connect/qqbot-nodejs` `1.0.4` is the best-fitting first-party SDK for
the Bridge's QQ private-chat and group-chat scope. It is a Tencent-owned,
TypeScript-first, protocol-level package with C2C and group message types, REST
sends, WebSocket/Webhook transports, access-token management, and exposed
protocol primitives. The older first-party `qq-guild-bot` package is centered
on QQ Guild/Channel integration and is not the right dependency for the
Bridge's required QQ C2C and QQ group contracts.

This is not a "drop in and trust its defaults" dependency. The Bridge should
pin the exact SDK version and add adapter contract tests because:

- official QQ documentation states that SDKs are reference implementations and
  the platform documentation remains authoritative;
- the published npm metadata and tagged source disagree about the minimum Node
  version;
- the SDK persists the Gateway sequence before awaiting durable application
  processing;
- its default debug logging includes message/request/response bodies;
- its built-in message deduplication is optional and in-memory only;
- ordinary message sends do not have a general retry or idempotency layer.

Sources: [QQ official getting-started page](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html),
[official SDK repository](https://github.com/tencent-connect/qqbot-nodejs),
[SDK README](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/README.md).

## Package identity and runtime requirements

| Item | Verified contract |
| --- | --- |
| Package | `@tencent-connect/qqbot-nodejs` |
| Latest npm dist-tag | `1.0.4` as observed on 2026-08-26 |
| Source tag/commit | tag `1.0.4`, commit `ca55d9c395b582b7fcfad0ec27209c35dd04e0b3` |
| License | MIT, copyright Tencent 2026 |
| Module format | Pure ESM, with TypeScript declarations and a separate `/protocol` export |
| Runtime | npm-published `1.0.4` metadata and `USAGE.md` say Node `>=18`; the tagged `package.json` and README say Node `>=20` |
| Direct runtime dependency | `ws` |

Primary sources: [npm latest metadata](https://registry.npmjs.org/@tencent-connect%2Fqqbot-nodejs/latest),
[tagged `package.json`](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/package.json),
[MIT license](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/LICENSE),
[README requirements](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/README.md#requirements),
[`USAGE.md` runtime requirement](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/USAGE.md#1-%E7%8E%AF%E5%A2%83%E8%A6%81%E6%B1%82).

The repository source at the `1.0.4` tag declares Node `>=20`, while the
artifact already published to npm under the same version declares Node `>=18`.
This is first-party metadata drift. The Bridge should use Node `>=20`, pin
`1.0.4` exactly (not a range), retain the npm integrity in the lockfile, and
test the installed tarball rather than assuming the Git tag and npm artifact
are byte-equivalent.

The QQ documentation's SDK list still links the older
[`tencent-connect/bot-node-sdk`](https://github.com/tencent-connect/bot-node-sdk)
as its Node.js SDK demo. That repository publishes `qq-guild-bot` (currently
`2.9.5` in npm metadata) and its own README calls it a QQ Guild Bot SDK. The
newer package is also under the Tencent Connect organization but is not yet
linked from the SDK-demo list. This documentation lag is another reason to pin
and contract-test the chosen package rather than dynamically following
`latest`. Sources: [official SDK-demo list](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html),
[`qq-guild-bot` npm metadata](https://registry.npmjs.org/qq-guild-bot/latest),
[legacy SDK README](https://github.com/tencent-connect/bot-node-sdk#readme).

## Authentication and client lifecycle

The platform issues an `AppID` and `AppSecret`. Token authentication is the
supported mechanism; the older Token authentication mode is deprecated. The
service exchanges `appId` and `clientSecret` for an `access_token`, then sends
`Authorization: QQBot ACCESS_TOKEN` on OpenAPI requests. The documented token
lifetime is up to 7,200 seconds; a new token becomes available near expiry,
with a 60-second overlap in which the previous token remains valid.

Sources: [official access-token documentation](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html),
[official authentication guide](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html).

The SDK accepts credentials only through `new QQBot({ appId, appSecret })`; it
does not read environment variables itself. Its default synchronous token
prefetch fails startup immediately on invalid credentials, then starts a
background refresh loop. `start()` opens the configured event transport and
blocks until `stop()` or an AbortSignal ends it. `stop()` terminates the
transport and token refreshers. Each `QQBot` instance owns separate token,
HTTP, upload-cache, and Gateway objects, so one instance per Channel Account is
compatible with Profile-local adapter supervision.

Sources: [SDK usage guide: credentials and lifecycle](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/USAGE.md#3-%E5%87%86%E5%A4%87%E5%B7%A5%E4%BD%9C),
[`QQBot` lifecycle source](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L440-L518),
[token manager source](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/token.ts).

There is hostname drift between the current official documentation and SDK
source: the docs show `api.bot.qq.com` for token/OpenAPI calls, while SDK
defaults use `bots.qq.com` for token acquisition and `api.sgroup.qq.com` for
OpenAPI. The adapter should not rewrite these defaults without a live contract
test, but its acceptance suite should prove token acquisition, `/gateway`, and
one message send against the pinned package.

## Event transport and connection lifecycle

### WebSocket

The platform flow is:

1. Fetch the Gateway URL over OpenAPI.
2. Connect to it and receive opcode `10` (`Hello`) containing the heartbeat
   interval.
3. Send opcode `2` (`Identify`) with `QQBot {access_token}`, intents, and shard.
4. Receive `READY` with a `session_id`.
5. Send opcode `1` heartbeats containing the latest received sequence `s`.
6. After a disconnect, send opcode `6` (`Resume`) with the token, session ID,
   and last processed sequence; the Gateway replays subsequent events and ends
   with `RESUMED`.

The official event page defines the common payload as top-level `id`, `op`,
`d`, `s`, and `t`. `id` is the event ID; `s` is the downstream sequence; `t`
is the event type. The official page explicitly recommends persisting `s`
after processing an event so Resume can replay events after it.

Source: [official event subscription and Gateway lifecycle](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html).

The SDK implements heartbeat, Identify, Resume, and fixed reconnect delays of
1, 2, 5, 10, 30, and 60 seconds, capped at 100 attempts. It waits 60 seconds
for Gateway close code `4008`, clears session state for invalid/out-of-range or
timed-out sessions, refreshes the token after authentication failures, and
treats insufficient/disallowed intents as fatal.

Sources: [Gateway constants](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/constants.ts),
[Gateway lifecycle](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/gateway-connection.ts),
[reconnect state machine](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/reconnect.ts).

Two SDK behaviors are not sufficient for the Bridge's durable-delivery
contract:

- on each frame, the SDK writes `lastSeq` to its persistence port before it
  dispatches the message to the application;
- message handlers are launched without awaiting completion.

Therefore a crash after the SDK advances `lastSeq` but before the Bridge commits
the normalized event can cause Resume to start after an uncommitted message.
The first release must not treat the SDK's `sessionPersistence` hook as a
durable acknowledgement. The adapter needs a pinned-version contract test and
either an upstream-supported post-commit sequence acknowledgement or a narrow
protocol-level wrapper whose removal condition is documented.

Evidence: [`lastSeq` persistence precedes dispatch](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/gateway-connection.ts#L203-L240).

### Webhook

The platform also supports HTTPS callbacks. It requires a configured HTTPS
address, permits ports 80, 443, 8080, and 8443, validates the callback, signs
event requests, and expects opcode `12` ACK. The SDK verifies Ed25519
signatures, ACKs valid dispatches immediately, and processes the handler in the
background so long-running work does not cause callback timeout and redelivery.

Sources: [official Webhook contract](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#webhook%E6%96%B9%E5%BC%8F),
[SDK Webhook transport](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/transport/webhook.ts),
[signature implementation](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/transport/webhook-verify.ts).

For the first release, WebSocket is operationally simpler because it does not
require exposing a public HTTPS callback. This should remain a configured
transport choice rather than an assumption of long-term platform availability:
the older official BotGo README warned that WebSocket would be phased out,
while the current July 2026 platform documentation and new Node SDK actively
document both transports. That first-party contradiction requires live
capability tests and an explicit future Webhook edge, not a hidden transport
switch. Sources: [BotGo notice](https://github.com/tencent-connect/botgo#%E6%B3%A8%E6%84%8F%E4%BA%8B%E9%A1%B9),
[current official event documentation](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html),
[new SDK transport documentation](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/README.md#dual-transport-websocket--webhook).

## Private-chat and group-chat inbound contracts

The required Gateway intent is `GROUP_AND_C2C_EVENT (1 << 25)`. Official
documentation lists `C2C_MESSAGE_CREATE`, `GROUP_AT_MESSAGE_CREATE`, and the
associated friend/group lifecycle and receive/reject events under that intent.
Subscription permissions are controlled by the platform, and requesting an
unauthorized intent closes the connection.

Source: [official intents table](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#%E4%BA%8B%E4%BB%B6%E8%AE%A2%E9%98%85intents).

| Bridge meaning | Provider event and fields | Identity key to retain |
| --- | --- | --- |
| Private message | `C2C_MESSAGE_CREATE`: `d.id`, `d.author.user_openid`, `d.content`, `d.timestamp`, optional attachments/message scene/elements | Channel Account Epoch + `user_openid` |
| Group @ message | `GROUP_AT_MESSAGE_CREATE`: message ID, `group_openid`, author `member_openid`, content, timestamp, mentions and attachments | conversation: Account Epoch + `group_openid`; participant: Account Epoch + `group_openid` + `member_openid` |
| Full group message | `GROUP_MESSAGE_CREATE`, available when "receive all messages" is enabled; fields match the group @ event | same as group @ message |

Sources: [C2C message event](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html),
[full group message event](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html),
[SDK protocol types](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/types.ts#L247-L293),
[SDK event normalizer](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/event-dispatcher.ts#L157-L273).

`username` is display data, not an identity. The official event schema also
exposes `union_openid` and `union_user_account`, but explicitly says they may be
empty. The initial adapter must not merge C2C `user_openid` and group
`member_openid`, or identities from different Channel Accounts, based on a
name or an assumed cross-context mapping.

## Provider event IDs, replay, and inbound deduplication

For message events, `d.id` is the message ID and is also the ID used for
passive replies and recall. The outer payload may additionally carry its own
event `id`; Gateway `s` is a sequence for Resume, not a durable business ID.
The platform warns that the same message ID may be delivered multiple times.
Its current message-event documentation says to combine message identity with
the `message_scene.ext` message index (`msg_idx`) for deduplication.

Sources: [common event payload](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#%E9%80%9A%E7%94%A8%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84-payload),
[C2C deduplication notice](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html),
[general message deduplication rule](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html#%E6%B6%88%E6%81%AF%E5%8E%BB%E9%87%8D).

The Bridge should construct its durable provider-event identity from the
Channel Account Epoch plus the provider message ID and, when present,
`msg_idx`. It should separately retain the outer event ID and Gateway sequence
only as correlation/reconciliation metadata. Deduplication must happen in the
Profile database before Codex work begins.

The SDK's optional `messageFilter()` remembers message IDs in an in-memory map
for only five seconds by default. It is useful for immediate self-echo/duplicate
noise, but it is not a durable deduplication boundary and does not survive
restart. Source: [SDK message filter](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/middleware/message-filter.ts).

## Sending and reply contracts

### Targets and routes

| Scope | REST route | Target identifier |
| --- | --- | --- |
| C2C private chat | `POST /v2/users/{user_openid}/messages` | `user_openid` |
| QQ group | `POST /v2/groups/{group_openid}/messages` | `group_openid` |

The SDK represents these as `ReplyTarget { scope: "c2c" | "group",
targetId, msgId? }` and derives targets from C2C `user_openid` or group
`group_openid`. Sources: [SDK routes](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/routes.ts#L9-L11),
[`ReplyTarget` and target derivation](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L77-L91),
[derivation source](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L1100-L1109).

### Passive reply versus proactive send

- A passive reply carries `msg_id`; a response to a non-message event carries
  `event_id` instead.
- `msg_seq` is combined with `msg_id`. Repeating the same `msg_id + msg_seq`
  fails; incrementing `msg_seq` permits multiple replies to one inbound
  message.
- A proactive message omits `msg_id` and `event_id`. The user can disable
  proactive messages, in which case the send fails.
- `is_wakeup=true` is a separate interaction-recall mode and is mutually
  exclusive with passive identifiers.
- Text uses `msg_type=0` plus `content`; Markdown uses `msg_type=2` plus
  `markdown`; rich media uses `msg_type=7` plus previously uploaded
  `media.file_info`.

Sources: [official message overview](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html),
[official group-send request fields](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html),
[SDK message API](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/messages.ts).

A successful send returns a provider message `id`, timestamp, and optionally
`ext_info.ref_idx`. The provider message ID is the receipt identity needed for
delivery correlation and later recall; `ref_idx` is the reference identity for
quoted replies. Source: [official group-send response](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html#%E5%93%8D%E5%BA%94).

### Reply windows and frequency hints

Current official limits are:

| Scope | Passive reply window | Replies per inbound message |
| --- | --- | --- |
| C2C | 60 minutes | 4 |
| Group | 5 minutes | 5 |

For proactive messages, the official overview currently lists C2C Bot limits
of 10 QPS for authenticated bots and 5 QPS plus 30 QPM for unverified bots,
with a per-relationship limit of 20 QPM and a daily ceiling of 1,000 per user.
For groups, it lists Bot limits of 60 QPM for authenticated bots and 30 QPM for
unverified bots, a per-relationship limit of 20 QPM, and 1,000 per group per
day. These are platform limits, not safe operating targets; provider errors and
future documentation changes remain authoritative.

Source: [official frequency and validity rules](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html#%E9%A2%91%E7%8E%87%E4%B8%8E%E6%97%B6%E6%95%88%E8%A7%84%E5%88%99).

### Retry and ambiguous outcomes

The SDK's ordinary message path performs a single HTTP request and throws a
structured `ApiError` containing HTTP status, platform business code, message,
and route. General response bodies do not expose a documented idempotency key
or a lookup-by-client-result-ID API. The SDK has retry policies for media upload
stages, but no general automatic retry for normal C2C/group message POSTs.

Sources: [API client](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/api-client.ts),
[message send implementation](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/messages.ts#L65-L102),
[retry policies](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/retry.ts).

For passive sends, the SDK helper generates a fresh random/time-derived
`msg_seq` on every `sendText()` call. A durable outbox retry must instead
persist the original passive `msg_id` and chosen `msg_seq` and use the raw send
API so it does not accidentally consume another reply slot. An ambiguous
network outcome cannot be called exactly once: retrying the same pair may be
rejected because the first send succeeded, while proactive sends have no
documented equivalent idempotency pair. The outbox must preserve one Logical
Result, record the ambiguity, and disclose the small duplicate/uncertain window.

Evidence: [SDK sequence generation and raw-send behavior](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/messages.ts#L65-L102),
[route sequence helper](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/routes.ts#L55-L65).

## Sandbox and production differences

Tencent's official BotGo quick start states that before a robot is published,
only configured sandbox members can access it, and a newly created robot adds
its creator to the sandbox by default. It also states that OpenAPI access is
restricted to configured outbound-IP allowlists. Production initialization in
that example uses the same OpenAPI client; the sandbox distinction is an
account/audience configuration boundary, not a separate SDK class or alternate
API host.

Source: [official BotGo quick start](https://github.com/tencent-connect/botgo#%E4%B8%80quick-start).

The new Node SDK exposes a single set of default token, API, and Gateway hosts
and has no `sandbox` option. Therefore the adapter should treat sandbox versus
production as platform-side robot status and audience/IP configuration. It
must not invent a second identity namespace or silently switch endpoints. Live
acceptance must separately prove:

1. the test member/account can initiate C2C interaction;
2. any configured test group is admitted and produces the expected group event;
3. the deployment's outbound IP is accepted;
4. the selected intents are authorized;
5. proactive-message tests stay within the test robot's current platform
   permissions and quotas.

Sources: [`QQBotOptions`](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L121-L181),
[official intent permission rule](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#%E6%9D%83%E9%99%90).

## Required adapter boundaries for this repository

Based on the verified provider contract, the QQ package should be used as a
Channel-owned protocol dependency behind the Bridge's channel-neutral adapter
interface. The Bridge remains responsible for Profile routing, durable inbound
deduplication, access policy, durable outbox state, retries, provider receipts,
and restart reconciliation.

The initial adapter should enforce these gates:

1. Pin `@tencent-connect/qqbot-nodejs` to exactly `1.0.4` and Node `>=20`.
2. Inject `AppID` and `AppSecret` from already resolved Secret References; do
   not let the SDK or examples discover environment files.
3. Subscribe only to `GROUP_AND_C2C_EVENT` and other explicitly required,
   platform-authorized intents rather than the SDK's broad `FULL_INTENTS`.
4. Normalize only the provider fields named above; retain raw platform payloads
   only where the Message Archive contract explicitly permits them.
5. Commit inbound identity/dedup state before accepting Codex work.
6. Do not rely on SDK session persistence as the durable processing cursor.
7. Persist passive `msg_id` and `msg_seq` in the outbox; use provider response
   `id` and `ext_info.ref_idx` as delivery receipts.
8. Keep provider throttling and bounded jitter in the adapter; the SDK's fixed
   reconnect sequence and media-only retries do not replace Bridge policy.
9. Pass a content-redacting logger. The SDK logs complete Gateway payloads,
   Webhook event bodies, REST request bodies, and REST response bodies at debug
   level, which violates the Bridge operational-log boundary if forwarded
   unchanged.
10. Contract-test token acquisition, Gateway Ready/Resume behavior, C2C and
    group normalization, duplicate delivery, passive reply, provider receipt,
    rate-limit/error mapping, disconnect, and restart before calling the
    Profile adapter ready.

Logging evidence: [Gateway payload debug log](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/gateway-connection.ts#L219-L223),
[REST request/response body logs](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/api-client.ts#L75-L115),
[Webhook payload debug log](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/transport/webhook.ts#L187-L194).

## Open contract questions to resolve with the real test robot

The primary sources do not establish these facts for the specific robot, so
they must remain live acceptance questions rather than assumptions:

- whether the robot currently has permission for C2C, group @, full-group
  messages, Markdown, media, buttons, and streaming;
- whether the sandbox currently admits QQ group testing for this robot;
- which Gateway close/error codes the account actually returns for missing
  intents or IP restrictions;
- whether platform-side duplicate rejection for the same passive
  `msg_id + msg_seq` can be distinguished reliably from other failures after an
  ambiguous network outcome;
- whether a provider reconciliation API exists for proactive sends (none is
  documented in the reviewed sources).

These questions can be tested without exposing credential values: report only
capability names, stable reason codes, provider HTTP/business codes, and
content-free correlation identifiers.
