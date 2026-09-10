# C2C expiry, rate and connection boundaries — 2026-09-10

Scope: the retained `9ea63a0` production snapshot, Tencent SDK 1.0.4, actual
test recipients, and the dedicated Linux Docker deployment. This follows
[QQ group delivery acceptance](qq-late-delivery-20260910.md). Windows remains
deferred future work. No Bridge runtime source or host Codex installation changed.

## Native model selection

At the user's request, both test Profiles now use `gpt-5.6-luna`. Native
`model/list` confirmed availability; CLI operations set each Profile's native
future-Thread defaults and its four existing QQ/WhatsApp private/group Threads.
Readback verified both defaults and all eight Threads, preserving reasoning
effort. The Linux settings survived the subsequent container restarts.
The original network-outage Turn preceded this selection change; its history
is not relabelled. Later native continuation and response-injection Turns used
the updated Thread setting.

## Real provider probes

These probes use the production QQ adapter and actual SDK REST transport with
a minimal ready facade. They do not open another Gateway connection or count
as native Codex Turn acceptance by themselves.

| Probe | Observed result | Boundary |
| --- | --- | --- |
| Oldest available C2C anchor for the same current test participant | At 8,160 minutes old, both a stream request and an ordinary passive reply were accepted. | No real C2C expiry rejection was observed; this is not an unlimited-lifetime promise. |
| Concurrent proactive sends | All 12 accepted; batch elapsed 462 ms. | No HTTP 429 or other rate rejection was observed. |
| Sequential proactive sends | All 31 accepted, with a deliberate 1,000 ms pause between completed sends. | No rate rejection was observed. These are bounded probes, not quota discovery or a claim that limits are absent. |

A separate real C2C stream accepted its initial generating frame and a DONE
frame 330,486 ms later using the same provider stream identity. The client
showed the initial generating message and its completed two-line form. This
verifies a held stream across five minutes in this test; it does not establish
an unlimited lifetime or add a native Codex Turn to the REST probe.

The previously observed group-anchor rejection remains separate evidence;
group code `40034005` does not establish C2C expiry behavior.

## Real network loss during a native Turn

The dedicated test container's bridge network was detached after the first
accepted C2C generation frame (one-character durable prefix), then restored
35,739 ms later. This cut **all container egress**, including the Channels and
Codex's provider traffic; it was not an isolated QQ-only socket fault.

The Supervisor, worker and native App Server core processes survived. During
the outage the input remained started and the answer frame was in `sending`.
After restoration, the same native Thread/Turn completed; one input correlation
remained, with no second input created. The stream fell back to the ordinary
Outbox. Three segments of 5,000, 5,000 and 4,014 characters were accepted on
attempt one with provider receipts. Their committed text contains all 150
numbered lines and the end marker; the recipient client displayed the final
line and marker. A fresh native request then reached the reconnected Gateway,
completed with the selected Luna setting and delivered its reply.

The health snapshot still reported `ready` during disconnection. This test
establishes recovery and delivery, not immediate link-failure detection. It
also does not identify whether the Gateway used RESUME or a new IDENTIFY, or
establish token-rollover behavior.

## Injected responses through the production delivery path

Because the real C2C probes did not produce the requested rejection conditions,
an operator-owned, temporary Node preload intercepted only the selected test
recipient's QQ requests in the dedicated Profile worker. The actual SDK HTTP
parser consumed the injected responses. All uninjected requests used the real
QQ service. This is **fault-injection evidence, not a real provider rejection**.
The release artifact and normal startup scripts were unchanged.

- **Expiry:** injected HTTP 400 / `304103` for one stream request and one
  passive final send. The production adapter then sent the real proactive
  fallback, received HTTP 200, and settled the final Outbox record on attempt
  one. The exact result was visible in the correct QQ private chat.
- **Rate/backoff:** one stream HTTP 429 forced complete-result fallback; two
  subsequent passive HTTP 429 responses produced persistent `retry_wait` with
  outcome `deferred`. The first scheduled retry was 977 ms after the observed
  wait state. The real provider then accepted attempt three, and the client
  received the result. Normal shutdown finished this delivery before exit,
  so it was not counted as pending-delivery restart evidence.
- **Abrupt restart while deferred:** a separate run killed the dedicated
  container with SIGKILL while attempt one was in `retry_wait`; process exit
  was 137 and the stopped database still retained `retry_wait`. After restart,
  one remaining injected 429 was followed by real HTTP 200 on attempt three.
  The Outbox record, Logical Result, reply sequence and payload digest were
  unchanged. There was still one input correlation, and the client received
  the final result.

An earlier intended crash run accidentally invoked graceful stop because its
test-script replacement did not apply. Its normal drain and accepted result
were retained but excluded from abrupt-restart acceptance. The corrected run
verified the actual kill command, exit 137 and persisted pending state.

## Cleanup and verdict

The fixture plan was disabled and its recipient selector removed. A normal
container restart confirmed that the preload was absent, both adapters were
ready, and the Luna settings were retained. With zero active inputs or pending
Outbox records and SQLite `quick_check` returning `ok`, the normal test container
then drained and exited zero. Persistent authentication, configuration, history
and startup scripts were retained. The Mac test Profile remains ready.

The exercised network-recovery, expiry-fallback and rate/restart mechanisms
passed, with no runtime defect reproduced in those paths. **Real C2C expiry
and rate-limit rejection remain unobserved.** FR-006 therefore remains
`awaiting-acceptance`; injected errors are not substituted for those provider
gates. The operator-local evidence keeps actual provider events, injected
events, excluded attempts and normal-start verification separate. No credentials,
raw provider identities or Channel/model bodies are included in this report.
