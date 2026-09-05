# Hermes dashboard operations: a bounded reference

Date: 2026-09-04. Scope: design reference for **Next**, not a statement that
these features are shipped in a Bridge release.

## Evidence and limits

Inspected the official `NousResearch/hermes-agent` source at
[`fcbd1076a93841fa88855acce810e342a5b78101`](https://github.com/NousResearch/hermes-agent/tree/fcbd1076a93841fa88855acce810e342a5b78101)
(local checkout, release commit `v0.20.5`, committed 2026-08-21). The only local
modification was an unrelated `tools/send_message_tool.py`; none of the sources
below was modified. This is a pinned snapshot, not a claim about latest Hermes.
No running Hermes configuration, credential values or log contents were read;
no Hermes lifecycle operation was executed.

## What the implementation actually provides

| Surface | Pinned-source behavior | Useful distinction |
| --- | --- | --- |
| Configuration | Profile-scoped form plus raw YAML editor; raw GET returns the resolved file path, raw PUT replaces the entire mapping, form PUT merges submitted fields. | Show the actual selected file; saving is not proof of runtime application. |
| API keys | Profile-scoped key editor over `.env`, separate from normal configuration; saving goes through credential lifecycle code. | A structured secret writer is not a raw `.env` text editor. |
| Logs | Agent/errors/gateway selector, level/component filters, bounded line counts and optional five-second polling. | This is file-tail polling, not token streaming or complete historical search. |
| Restart | Dashboard starts an explicit, profile-targeted gateway restart action and reports an action PID. | A spawned action is not readiness; observe the target after restart. |

Sources: [raw YAML endpoints](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L15250-L15294),
[form save](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L7645-L7684),
[secret save](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L7908-L7931),
[log UI](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/web/src/pages/LogsPage.tsx#L24-L150),
[restart endpoint](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L4708-L4722).

### Do not assume the profile switcher also scopes logs

At this snapshot, the log endpoint has **no profile argument** and reads
`get_hermes_home()/logs/<allowlisted filename>`. The frontend's automatically
profile-scoped endpoint list includes config, env and gateway, but not logs.
Therefore this implementation does **not** establish a unified dashboard with
switchable per-profile log tails. Its layout is useful; that particular
isolation behavior must be designed and tested in the Bridge itself.
[Backend](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L12348-L12400),
[frontend scope list](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/web/src/lib/api.ts#L66-L99).

### When changes take effect

Hermes's documentation says config changes apply to the next agent session or
gateway restart; channel credentials/enabled state connect on the next gateway
restart. It separately documents CLI `/reload` for rereading `.env` inside an
active CLI process. These are distinct operations, not universal hot reload.
[Configuration and channel guidance](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/website/docs/user-guide/features/web-dashboard.md#L204-L419).

The source writes `.env` atomically and updates the **writing process's**
environment. That assignment cannot itself update a separate running gateway's
environment. Some Hermes config consumers refresh independently, so neither
“everything requires restart” nor “Save reloads everything” is a valid blanket
statement. The restart helper coalesces in-flight/recent requests, but its
endpoint is an immediate restart path rather than the Bridge's bounded-drain
contract.
[Environment writer](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/config.py#L4266-L4298),
[restart helper and drain distinction](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L4626-L4749).

## Minimal Bridge adaptation (recommendation, not shipped behavior)

1. Show the selected deployment's actual `config.yaml` path and load its current
   contents by default. Keep **Save**, **Validate** and **Apply** distinct, and
   show persisted versus active Configuration Revision plus affected Profiles.
2. Keep secrets in each Profile's `secrets.env` through the existing secret
   writer. Show location and configured/changed state, never a raw credential
   document or saved-value preview. Explain that process environment overrides
   this file; a child restart cannot refresh the parent's inherited environment.
3. Add a Profile filter to a bounded, content-free operational log view. Identify
   its source, time range, retention/gaps and refresh state. Recent dashboard
   actions alone are not runtime logs. Reuse platform-collected Supervisor JSON
   output; do not invent competing log rotation or include Codex/message bodies.
4. Display the required action from the existing control plane: no restart,
   affected-Profile drain/restart, or operator-managed Supervisor restart.
   A restart button must call an authorized, bounded lifecycle operation, show
   its scope, disable repeat clicks and wait for readiness. Do not emulate an
   OS service manager by killing a PID from the browser.

Do not import Hermes runtime, per-profile gateway services, model/approval
editors, arbitrary log-file access, or credential mirrors in YAML. Bridge
Profiles retain separate workers, Codex remains authoritative, and the shared
Supervisor remains one operating-system service.
