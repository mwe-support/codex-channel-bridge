# QQ and WhatsApp approval reliability — Next

- Date: 2026-09-05, native macOS; Codex CLI 0.149.1.
- Historical implementation checkpoint: the then-uncommitted working tree based
  on `4a655d34b038d33b3b53eb8af099ca0b8c03f9c6`. The source hashes below identify
  that checkpoint, not a later tagged tree; its release notes and gates are
  authoritative for release identity.
- Final source SHA-256:
  - `codex-server-request-router.ts`:
    `a5c61b4a976aef7336da411acaef032851a15187e318d97b4df57898d519364d`
  - `profile-worker.ts`:
    `7a872ce2a3bcf09b15a41c55d8434199093c65d4a8ed9194543eed93c848cb73`

## Changed behavior

Project native `serverRequest/resolved` and terminal Turn notifications into
token invalidation and cancellation of unsent durable prompts. A generation
closed during a failed response write cannot resurrect the token. Successful
Channel responses attempt a short acknowledgement; invalid, duplicate, expired
or wrong-context responses attempt the same non-disclosing rejection reply.
These replies do not claim native operation success.

Sources checked: the official [App Server approval contract](https://learn.chatgpt.com/docs/app-server#approvals),
0.149.1-generated command/file approval and ServerRequestResolved schemas, and
the pinned [upstream request cancellation implementation](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/app-server/src/outgoing_message.rs).
No Bridge Reviewer policy or Codex installation changes were introduced.

## Real client acceptance

The existing Profile's native `auto_review` completed harmless `pwd` probes in
both private conversations without pending Channel approvals. That is not
counted as manual approval acceptance. A temporary administrator-supplied
executable wrapper selected native `user` review for the test process. Fresh
test Threads avoided overriding restored Thread settings.

| Scenario | QQ private chat | WhatsApp private chat |
| --- | --- | --- |
| Real command approval prompt | Client-visible, provider accepted | Client-visible, provider accepted |
| Native decision | `accept`, durable state `responded` | `decline`, durable state `responded` |
| Repeated decision | Rejected; no second native response | Rejected; no second native response |
| `/stop` while pending | `cancelled / codex_request_resolved` | `cancelled / codex_request_resolved` |
| Response timeout (30-second test setting) | `expired / response_timeout` | `expired / response_timeout` |
| Cancelled/expired token response | Rejected | Rejected |

A WhatsApp token sent through QQ was rejected without resolving either pending
request. Six real approvals were retained: two responded (one accept and one
decline), two native cancellations and two expirations; all six presentations
were provider-accepted. Client inspection distinguished off-screen/omitted
accessibility text from a missing message, including screenshot verification of
the WhatsApp timeout prompt.

After restoring configuration and restarting the final candidate, old tokens
were submitted from both clients without new native work. The original private
Thread bindings, native `auto_review` default and five-minute response timeout
were restored; group bindings were unchanged. Supervisor and both adapters were
ready, all 43 existing/test input correlations were terminal, and the independent
Dashboard listener remained available. Temporary reviewer selection was not
written into the host Codex configuration.

## Automated checks and limits

- `npm test`: 241 unit tests, 4 release-tool tests and 4 platform contract tests,
  all passed. Relevant checks cover wrong Profile/account/epoch/conversation/
  participant, typed request IDs, native cancellation, duplicate/expired tokens,
  closed-generation write failure, Outbox retry and worker restart behavior.
- `npm run test:contract`: passed on the actual host with schema SHA-256
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`.
  The initial tool-sandbox run failed with App Server stdout closing; it was not
  reported as a successful native check.
- English and Chinese documentation builds and `git diff --check` passed.

This run does not claim live group approval, live file-change approval, all
Codex server-request families, or guaranteed QQ delivery outside provider reply
permissions. Fault injection and retry checks supplement, not replace, the real
private-channel command-approval results above. Existing release gates remain.

## Output-file preflight, not file-delivery acceptance

Using Tencent SDK 1.0.4, a harmless generated text buffer was uploaded as a
generic file for the configured private test recipient, with automatic sending
disabled. QQ returned a valid file reference and a 86,400-second TTL. No second
Gateway was opened. This proves only upload capability: it does not prove
message acceptance, recipient download, durable file retry or WhatsApp file
delivery. The user-facing file authorization entry point remains to be decided.

No credentials, tokens, raw provider identifiers, message bodies, command output,
file references, signed URLs or authentication material are retained here.
