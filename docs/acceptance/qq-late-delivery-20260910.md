# QQ late delivery and concurrent interruption — 2026-09-10

Continuation of [mainline boundary acceptance](mainline-closeout-20260909.md).
The operator enabled the test group's proactive bot permission. Native Linux
restarted from the retained `9ea63a0` snapshot, with its existing Profile,
authentication and bindings. Both adapters returned ready; no credentials,
native Codex installation or runtime source were changed.

## Expired-anchor fallback

A production-adapter/pinned-SDK REST probe reused the same old group anchor that
previously failed. The passive request again returned HTTP 400 / business code
`40034005`. Its automatic proactive fallback was now accepted, and the exact
probe reply was independently visible under the correct Bot in the QQ group.
The previous permission-denied result was preserved separately.

This establishes the real expired-anchor-to-proactive branch. The probe used a
minimal ready facade and did not create a second Gateway connection or test a
Codex Turn by itself.

## Real six-minute group Turn

A fresh, addressed QQ group request ran a foreground 360-second wait through
its ordinary Codex Thread. The Turn completed after 372,419 ms. Its single
terminal Outbox record was accepted on attempt one with a provider receipt,
and the QQ group client showed the same complete text as the committed result.
No answer-stream record existed for the group. The group completed 210,352 ms
after the private interruption below, confirming continued independent work.

## Private stream while the group remained active

The same QQ Channel Account received a separate private request on a distinct
native Thread. During group execution, the private stream received generation
frames and its growing numbered text was visible in the recipient client.
The operator then sent `/stop` in that private conversation. An immediate
readback showed private `interrupted` and group still `started`.

The private Turn lasted 29,103 ms. At interruption it had 30 accepted generation
frames and a 3,905-character durable prefix. Its state became `fallback`; the
interruption notification was accepted on Outbox attempt one at reply sequence
2 and appeared in the private client. This is interruption/recipient isolation
evidence, not a claim that the interrupted stream received a successful DONE.

## Scope and retained gates

- The successful REST fallback and ordinary group Turn are separate evidence.
  The group Turn's provider HTTP branches are not inferred from its Outbox row.
- This is native Linux provider acceptance, not a new Docker or Windows run.
- Real C2C expiry rejection, provider rate-limit rejection, and other unobserved
  stream/connection boundaries remain open. FR-006 remains `awaiting-acceptance`.
- Historical failed deliveries were not rewritten or silently replayed. No
  release tag, project version or published artifact was changed.

After acceptance, the Profile had no active input, pending approval or pending
Outbox delivery; SQLite `quick_check` returned `ok`. Native Linux completed its
bounded drain and exited zero. Persistent configuration, authentication, history
and startup scripts remain; the test runtime is stopped.
