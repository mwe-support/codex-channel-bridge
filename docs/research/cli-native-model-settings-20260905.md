# Native Codex Model and Reasoning Settings for the Bridge CLI

- Research date: 2026-09-05 (Asia/Shanghai).
- Ownership: model discovery, Thread settings and Codex configuration are
  Codex-owned. The Bridge CLI projects native methods through the selected
  Profile worker; it must not persist a competing model selection.
- Evidence: administrator-supplied executable resolved from this terminal's
  `PATH`, generated stable/experimental schemas, official documentation, and
  [upstream snapshot `ddf04ad26789d040f9ef6a96736f76602e35a6cc`](https://github.com/openai/codex/commit/ddf04ad26789d040f9ef6a96736f76602e35a6cc).
  Upstream main is implementation evidence, not proof that its source exactly
  matches the installed executable. Each real Profile's configured executable
  still requires its own schema and live capability checks.

## Local executable evidence

The existing probe resolves a Profile's explicit `codexExecutable`, falling
back to `codex` on its service PATH. Research used the terminal PATH fallback;
no live Profile config, Codex home or authentication material was read.

```sh
codex --version
codex app-server generate-json-schema --out /tmp/codex-cli-native-settings-stable-20260905
codex app-server generate-json-schema --experimental --out /tmp/codex-cli-native-settings-experimental-20260905
```

All three commands exited 0; version output was `codex-cli 0.153.4`.
Each emitted a sandbox warning that PATH aliases could not be created; schema
generation still succeeded. SHA-256 of `codex_app_server_protocol.v2.schemas.json`:

| Surface | SHA-256 |
|---|---|
| Stable | `d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a` |
| Experimental | `e5f798fd1343c539f01fedea0e8a84a43c080fcca4615c80eb04a5edab4f7d0a` |

These hashes identify evidence, not compatibility gates. No App Server was
started and no model request, Thread mutation or config write was performed
for this research. Live terminal acceptance remains implementation work.

## Minimal native field shapes

| Operation | Request | Relevant response |
|---|---|---|
| Model discovery | `model/list {cursor?, limit?, includeHidden?}` | `data[]`, `nextCursor`; model entries include `model`, `displayName`, `supportedReasoningEfforts`, `defaultReasoningEffort`, `isDefault` |
| Thread settings query | `thread/read {threadId, includeTurns:false}` | `thread.model`, `thread.reasoningEffort`, `thread.modelProvider` |
| Thread settings change | `thread/settings/update {threadId, model?, effort?}` | `{}` plus native `thread/settings/updated` notification |
| Codex default query | `config/read {includeLayers:true, cwd?}` | `config.model`, `config.model_reasoning_effort`, `origins`, `layers` |
| One default change | `config/value/write {keyPath, value, mergeStrategy:"replace", expectedVersion?}` | `status`, `version`, `filePath`, optional `overriddenMetadata` |
| Atomic related defaults | `config/batchWrite {edits:[{keyPath,value,mergeStrategy:"replace"}], expectedVersion?, reloadUserConfig:false}` | Same write response |

`thread/settings/update` is experimental on the inspected executable; the
other listed methods have stable request schemas. Probe both surfaces so
future promotion does not disable the method. Do not hard-code the model or
reasoning catalog; paginate `model/list` and use each returned model's effort
options. Official overview: [Codex App Server](https://developers.openai.com/codex/app-server).

## Scope and timing

**Read without resume:** generated `Thread` describes model and effort as
current configured values when loaded, otherwise latest persisted values;
null means unset or unavailable. These are not per-turn execution telemetry.
The pinned handler reads persisted metadata plus optional existing live state,
so a settings query need not resume, subscribe, or create a Thread. Project
only the settings fields: `thread/read` also returns private preview/path data.
Source: [Thread read handler](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/src/request_processors/thread_processor.rs#L2823-L2908).

**Updates affect subsequent turns:** request fields document that timing.
An official test updates model while a Turn is active and receives the settings
notification. The handler submits a core settings operation and returns `{}`;
use the notification or native readback to establish applied values rather than
treating an empty acknowledgement as complete evidence. A cold Thread may need
the existing mutation/resume path, but a read-only query does not.
Sources: [protocol fields](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L226-L278),
[handler](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/src/request_processors/turn_processor.rs#L906-L953),
[active-turn contract test](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs#L240-L282).

**Defaults are not Thread updates:** `config/batchWrite` explicitly excludes
session-static model and reasoning defaults from hot reload, even when
`reloadUserConfig` is true. Set Profile-wide future defaults through the
Profile's native config API; change an existing Thread through its settings
method. Bridge Profiles and Codex's own named config profiles are distinct.
Source: [session-default handling](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/src/request_processors/config_processor.rs#L151-L175).

## Configuration concurrency and output boundaries

- Read layers immediately before a proposed write. `expectedVersion` is the
  **active user layer's version**, not the version of an arbitrary key origin
  or the effective merged configuration. A mismatch returns
  `ConfigVersionConflict`; reread and show a new preview instead of overwriting.
- `filePath` omission selects Codex's active user configuration. The pinned
  implementation rejects other paths with `ConfigLayerReadonly`; do not expose
  a general path override in the Bridge model CLI. Native user layers can carry
  a Codex config-profile selector, so do not assume the first user layer is
  necessarily the active one when several are returned.
- Use a single batch for related model/effort defaults. Surface `okOverridden`
  when higher-precedence config masks the write; read back effective values.
- Never print raw `config/read`, `layers`, `origins`, native paths or complete
  write responses. Allowlist model and effort fields plus body-free outcome
  metadata; native configuration can contain unrelated sensitive material.
- Do not parse or rewrite `config.toml`, private databases or rollout files,
  create a second App Server for a live Profile, or mutate the host Codex CLI.

Source: [user-layer path and version checks](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/src/config_manager_service.rs#L217-L254).
