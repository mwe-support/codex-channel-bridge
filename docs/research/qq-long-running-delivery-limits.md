# QQ Open Platform limits for long-running task delivery

Research date: 2026-08-27

## Contract clarification — 2026-09-04

The user reaffirmed QQ private-chat native streaming as the required delivery
behavior; QQ groups and WhatsApp retain complete-text replies. The earlier
WhatsApp simulated-streaming rollback does not cancel this requirement. See
[FR-006](../feature-requirements.md#fr-006--qq-private-chat-native-streaming).
The historical recommendation below to keep C2C streaming optional describes
the unverified implementation baseline, not the accepted target behavior.

A read-only recheck on 2026-09-04 confirmed that the official
[C2C endpoint](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
still supports native streaming and the
[group endpoint](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
still explicitly excludes streaming parameters. SDK 1.0.4 provides `openStream`,
but the pre-fix Bridge QQ Adapter used only discrete sends. The Next working tree
now implements native streaming ([implementation](../qq-adapter.md)). A real-account
test subsequently verified 44 accepted frames including DONE and visible incremental
rendering; full boundary acceptance remains pending. `remain_msg_len=0` was returned
throughout accepted continuation, so it must not be used as a writable-capacity
guard. This is an observed provider result, not a guarantee about undocumented
field semantics. See [acceptance evidence](../acceptance/qq-native-streaming.md).
Ordinary reply receipts must not be counted as streaming acceptance.

## Original research

This note evaluates whether QQ can present a long-running Codex task like a
native Codex streaming client. It uses Tencent's official QQ Bot documentation
and the exact first-party SDK pinned by this repository:
**@tencent-connect/qqbot-nodejs 1.0.4**, commit
**ca55d9c395b582b7fcfad0ec27209c35dd04e0b3**. No credentials or message bodies
were inspected, and no live message was sent.

Evidence labels:

- **Platform fact**: stated by current QQ Bot official documentation.
- **SDK observation**: directly observed in Tencent's pinned SDK source.
- **Bridge inference**: a design consequence, not a Tencent guarantee.
- **Unknown**: the reviewed first-party sources do not settle it.

## Decision

QQ must not be modeled generally as a Codex-style streaming surface.

- QQ has a real same-message streaming API, but only for C2C private chat.
- QQ group chat explicitly does not support streaming parameters.
- Passive replies have a time window and a per-inbound-message reply count.
- A late proactive result can be disabled by the user or group administrator
  and is also quota-limited.
- A successful long Codex Turn therefore does not guarantee that its final
  result can still be delivered through the original QQ interaction.

Use an immediate durable acceptance acknowledgement, sparse state-change
progress, and one durable final result. C2C streaming remains an optional
capability until a real-robot contract test passes. Group delivery is always
discrete. At final-send time the Bridge must choose a valid passive reply, an
authorized proactive send, or an explicit requirement for a fresh interaction.

## 1. Passive and proactive limits

| Scope | Passive validity | Replies per inbound message | Proactive Bot limit | Per relationship | Daily relationship limit |
| --- | ---: | ---: | ---: | ---: | ---: |
| C2C | 60 minutes in page summary | 4 | verified: 10 QPS; unverified: 5 QPS and 30 QPM | 20 QPM | 1,000 per user |
| Group | 5 minutes | 5 | verified: 60 QPM; unverified: 30 QPM | 20 QPM | 1,000 per group |

**Platform fact.** The official
[message overview](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html),
[C2C send API](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html),
and
[group send API](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
state these values (retrieved 2026-08-27). The normal C2C and group send
endpoints each advertise 100 QPS, but that endpoint ceiling does not replace the
stricter proactive quotas above.

**Platform fact.** QQ users can disable proactive messages. Gateway events also
include C2C_MSG_REJECT / C2C_MSG_RECEIVE and GROUP_MSG_REJECT /
GROUP_MSG_RECEIVE for relationship-state changes. See the official
[event intents table](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#%E4%BA%8B%E4%BB%B6%E8%AE%A2%E9%98%85intents)
(retrieved 2026-08-27).

Interaction recall with is_wakeup is not a general long-task channel. The
official overview allows only one message in each of four periods during the
30 days after user interaction: same day, days 1-3, days 3-7, and days 7-30.

### First-party documentation conflict

The current C2C page summary says 60 minutes and four replies, while the msg_id
field on the same page says that the ID is valid for five minutes. Tencent's SDK
usage guide also says that a stream must be based on an inbound message from the
previous five minutes. The stream API publishes no separate start window or
maximum lifetime.

**Unknown.** The sources do not establish whether the five-minute field is
stale, streaming has a narrower window, or 60 minutes governs both. Historical
success after about 395 seconds or 1,917 seconds for one robot would prove only
that the robot once succeeded beyond five minutes; it would not prove a
60-minute contract or a stream lifetime. The first implementation must use five
minutes conservatively until live boundary tests record current provider codes.

Sources, retrieved 2026-08-27:

- [official C2C send API](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
- [official C2C stream API](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
- [Tencent SDK streaming guide](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/USAGE.md#11-c2c-%E6%B5%81%E5%BC%8F%E6%B6%88%E6%81%AFstream_messages)

## 2. Reply identity and retries

**Platform fact.** A passive reply carries msg_id. Repeating the same
msg_id + msg_seq fails; increasing msg_seq permits another reply to the same
inbound message. The same inbound message can be pushed more than once, so
inbound deduplication remains required. See the official
[deduplication rule](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html#%E6%B6%88%E6%81%AF%E5%8E%BB%E9%87%8D)
(retrieved 2026-08-27).

**SDK observation.** sendMessage creates a fresh msg_seq on every call.
sendRaw also creates one when the caller omits it. The helper does not persist
the sequence or offer result reconciliation. See Tencent's
[messages.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/messages.ts#L65-L102)
and
[routes.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/routes.ts#L53-L62)
(retrieved 2026-08-27).

**Bridge inference.** Persist the chosen msg_id + msg_seq before the first
passive send and reuse it for an ambiguous retry. Generating a new sequence
during retry can consume another reply slot and create a visible duplicate.

For streaming, persist stream_msg_id, the stable msg_seq, next index, last
accepted prefix, and whether QQ accepted a terminal DONE frame.

## 3. What QQ streaming is

**Platform fact.** C2C supports
POST /v2/users/{user_openid}/stream_messages at 50 QPS. The first frame returns
stream_msg_id; later frames carry that ID and increase index from zero.
input_state 1 means generating and 10 means done. input_mode supports append or
replace, and the response can contain remain_msg_len.

Under replace, content already delivered by QQ is an immutable prefix. Changing
it produces error 40007. This is a generated-answer stream, not a general
edit-any-previous-content API.

Source: official
[C2C stream API](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
(retrieved 2026-08-27; page updated 2026-07-22).

**Platform fact.** The group send page explicitly says group messages do not
support streaming parameters. Ordinary C2C and group messages have recall, not
a general edit or patch API; recall is unavailable after two minutes.

Sources: official
[group send API](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
and
[message overview](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html#%E6%92%A4%E5%9B%9E%E6%B6%88%E6%81%AF)
(retrieved 2026-08-27).

### Pinned SDK behavior and risk

**SDK observation.** StreamSession:

- accepts full accumulated text rather than a delta;
- fixes replace plus Markdown, one msg_seq, and increasing index values;
- throttles to 500 ms by default and refuses intervals below 300 ms;
- retries rate limits at most three times;
- sends DONE from complete();
- cannot open without a C2C inbound msgId.

Sources: Tencent's
[streaming.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/streaming.ts#L22-L245)
and
[QQBot.openStream](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/QQBot.ts#L887-L915)
(retrieved 2026-08-27).

The 300 ms minimum is an SDK rule described as best practice. The official API
page publishes 50 QPS but does not state a 300 ms protocol minimum.

**SDK observation requiring a live test.** The official schema says event_id
and msg_id are alternatives and its examples send only msg_id. The pinned
StreamSession defaults eventId to msgId and serializes both fields. Production
must not enable the helper before a real-account test; use the protocol-level
API with one passive anchor if the provider rejects this shape.

Sources: official
[stream request fields](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
and Tencent's
[request construction](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/streaming.ts#L172-L197)
(retrieved 2026-08-27).

**SDK observation.** The official stream response defines remain_msg_len, but
the pinned MessageResponse type and StreamSession do not expose or act on it.
The helper therefore cannot enforce a provider-reported remaining-length
boundary.

### Unknown stream limits

The reviewed first-party sources do not publish:

- maximum stream lifetime;
- maximum frame count;
- maximum total text or the initial remain_msg_len;
- whether frames consume one or several of the four passive reply slots;
- whether a stream can continue after the original passive window ends;
- interruption and restart recovery guarantees;
- per-robot production or sandbox availability.

These are live acceptance gates for any long-turn streaming promise.

## 4. Content and media

**Platform fact.** C2C and group support text, Markdown, and rich media. Current
official documentation says custom Markdown is open to all C2C and group bots.
C2C also supports msg_type 6 input status, but input_second is at most 60
seconds.

Sources: official
[message types](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html),
[Markdown documentation](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html),
and
[C2C send API](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
(retrieved 2026-08-27).

**Unknown.** Tencent does not say that repeated input notifications extend the
reply window or avoid reply-count consumption. They are not a long-task
keepalive.

The C2C and group APIs list error 40054007, message length exceeded, but publish
no numeric ordinary text or Markdown maximum. The stream response has dynamic
remain_msg_len but no published initial maximum. Do not present a local 4,000
or 5,000-character constant as a Tencent contract.

**Platform fact.** C2C and group upload endpoints are not interchangeable.
file_info has a provider-returned ttl. Current media limits are:

| Media | Soft | Hard | Above soft |
| --- | ---: | ---: | --- |
| PNG/JPG | 20 MB | 200 MB | downgrade to file |
| MP4 | 30 MB | 200 MB | downgrade to file |
| SILK | 20 MB | 200 MB | downgrade to file |
| File | 200 MB | 200 MB | rejected above hard limit |

Large/local files use prepare, part upload, part finish, and merge. Default
parts are about 5 MB, but upload_config supplies part size, concurrency, and
retry policy.

Sources: official
[rich-media overview](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html),
[C2C upload](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html),
and
[group upload](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html)
(retrieved 2026-08-27).

## 5. Gateway, Session, and Token

**Platform fact.** Gateway Hello supplies heartbeat_interval. The client sends
heartbeats with the latest sequence. A short disconnect can Resume with
session_id and the last processed sequence, after which QQ replays later
events. The documentation gives no fixed Session lifetime.

Source: official
[Gateway lifecycle](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
(retrieved 2026-08-27).

**SDK observation.** The pinned SDK handles reconnect, invalid or timed-out
Session, out-of-range sequence, token refresh, and Gateway rate limits. It
launches incoming message handlers without awaiting completion, so a long
application handler does not itself stop heartbeat. It nevertheless persists
lastSeq before the Bridge durably commits the message, which is a separate
crash-consistency gap.

Sources: Tencent's
[gateway connection](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/gateway-connection.ts#L203-L268)
and
[reconnect state](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/gateway/reconnect.ts#L51-L119)
(retrieved 2026-08-27).

**Platform fact.** access_token normally lasts 7,200 seconds. Fetching during
the last 60 seconds returns a new token while the old token remains valid during
that overlap. The SDK caches and refreshes tokens ahead of expiry.

Sources: official
[access-token documentation](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
and Tencent's
[token manager](https://github.com/tencent-connect/qqbot-nodejs/blob/ca55d9c395b582b7fcfad0ec27209c35dd04e0b3/src/protocol/api/token.ts#L44-L165)
(retrieved 2026-08-27).

**Bridge inference.** Gateway Session, Codex Turn, QQ stream, and final delivery
are separate lifecycles. Gateway reconnect must not cancel the Codex Turn, and
a healthy Codex Turn must not imply that the original passive reply remains
usable.

## 6. Long-task delivery contract

1. Commit inbound identity and Codex input correlation before work starts.
2. Promptly send one acceptance acknowledgement and persist its delivery mode,
   passive anchor, msg_seq, and provider receipt.
3. Do not project every Codex token or item to QQ.
4. Emit only coarse state changes and reserve passive capacity for failure and
   final delivery.
5. Commit the Logical Result and Outbox before any terminal send.
6. At delivery time choose passive, proactive, or awaiting_user_reentry.
   Do not retry a definitely expired passive ID forever.
7. Reuse persisted provider identity on an ambiguous retry and disclose the
   duplicate window where applicable.

For C2C, keep discrete acceptance plus final as the default until stream tests
pass. If enabled, open one stream promptly, coalesce deltas, preserve the sent
prefix, and require an accepted DONE frame. On stream failure, use one discrete
final if passive or proactive delivery remains available.

For groups, never expose streaming. Send immediate acceptance, suppress
token-level progress, and limit milestones so the five passive slots are not
spent before the final. Work expected to exceed five minutes depends on
proactive permission; otherwise a new authorized message or status command must
create a fresh reply anchor.

Distinguish at least: codex_failed, qq_passive_expired,
qq_proactive_disabled, qq_rate_limited, qq_stream_incomplete,
qq_delivery_ambiguous, and awaiting_user_reentry. A committed backend result is
not delivered until QQ returns a correlated receipt.

## 7. Required live acceptance tests

Using the configured test robot and content-free logs:

1. Test C2C ordinary replies around 4m30s, 5m30s, and near 60 minutes.
2. Test the high-level SDK stream request containing both event_id and msg_id.
3. Test a raw stream with one passive anchor, stable msg_seq, increasing index,
   and accepted DONE.
4. Keep a stream open across five minutes and record whether later frames and
   complete succeed.
5. Determine whether stream frames or repeated input status consume passive
   reply slots.
6. Test group replies around 4m30s and 5m30s, including the sixth reply.
7. Test proactive delivery with provider permission enabled and disabled.
8. Probe ordinary length and stream remain_msg_len without adopting an
   unofficial numeric limit.
9. Disconnect and Resume Gateway and roll the token during a synthetic long
   task, proving backend and Outbox continuity separately.
10. Re-send one ambiguous passive result with the same msg_id + msg_seq and
    record the provider code without logging IDs or content.

## 8. Current repository consequences

The current adapter exposes only discrete sendText. It retains a local
5,000-character ceiling, which is not evidence of Tencent's true text limit.
Passive sends now use an Outbox-allocated, persisted msg_seq and the explicit
SDK raw-send path; Provider reconciliation after a lost response remains
unavailable.

Before implementing long-task UI:

1. make QQ delivery mode explicit: passive, proactive, or c2c_stream;
2. retain the implemented passive identity persistence and add stream identity
   persistence before sending;
3. add capability results for C2C streaming and proactive delivery;
4. keep group progress discrete and separately configurable;
5. stop treating 5,000 as an official QQ limit;
6. complete the live tests before enabling streaming by default.

Relevant files:

- [QQ adapter](https://github.com/mwe-support/codex-channel-bridge/blob/main/packages/qq-adapter/src/qq-adapter.ts)
- [QQ adapter baseline](../qq-adapter.md)
- [delivery baseline](../delivery.md)

These are Channel-owned constraints. They do not alter Codex-native Turn,
steering, interruption, compaction, or Reviewer behavior.
