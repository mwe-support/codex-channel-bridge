---
title: Channel commands
---

# Channel commands

The Bridge parses the same command set for QQ and WhatsApp. Access Policy and
the active-controller rule are applied before a command can change state.
Prefix a message with `//` to send one literal leading slash to Codex.

| Command | Effect |
| --- | --- |
| `/help` | Show supported syntax locally; no Codex Turn. |
| `/status` | Show Profile readiness, active work, and queue state locally. |
| `/new` | Detach the current Binding so the next admitted message starts a new native Thread. |
| `/attach THREAD_ID` | Bind a native Thread only when its resolved working directory equals the Profile Workspace. |
| `/detach` | Remove the Bridge-owned Conversation-to-Thread Binding. |
| `/stop` | Call native `turn/interrupt` for the exact active Thread and Turn. |
| `/approve TOKEN DECISION` | Answer the original native Approval Request with a bounded opaque token. |
| `/model` | Show the current bound native Thread model, without changing it. |
| `/reasoning` | Show the current bound native Thread reasoning effort, without changing it. |
| `/model MODEL_ID` | Select a model discovered from native `model/list`. |
| `/reasoning EFFORT` | Select an effort supported by the current native model. |

`/model` and `/reasoning` project into native Thread settings; the Bridge does
not keep a competing catalog or Profile-wide selection. Approval tokens expire,
cannot be reused, and are valid only for the authorized controlling participant.

The bare queries reuse `thread/resume` with only `threadId`, reading its native
`model` / `reasoningEffort` response; no setting overrides or model Turn are sent.
Codex may load an unloaded Thread. Null effort is shown as `Codex default
(unspecified)`; the Bridge does not guess an effective effort. Queries require an
existing binding, work in authorized shared groups, and do not require the
experimental settings-update capability. Parameterized commands retain their
existing capability checks and shared-group administrator restriction.
See [FR-007](feature-requirements.md#fr-007--current-model-and-reasoning-queries) and
the [native App Server contract](https://developers.openai.com/codex/app-server).

In QQ groups, select the Bot in the real mention picker before the command.
For provider-confirmed addressed group events, the adapter strips leading QQ
mention markup (including opaque IDs not equal to AppID) before the core parser.
It does not strip mentions from passive events or from the middle of text.

In the default `steer` admission mode, a second admitted ordinary message for
the same active binding uses native `turn/steer` with the exact expected Turn.
It does not create a new Turn or a general queue. See [Admission](admission.md),
[Thread Binding](thread-binding.md), and [Approval routing](approval-routing.md).
