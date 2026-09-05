# Bridge administration CLI

Status: Next, FR-013; not yet released. Run `bridge --help` or
`bridge <group> --help`. From a built source checkout, replace `bridge` with
`node packages/cli/dist/main.js`.

## Setup and configuration

```sh
bridge setup quick --config /absolute/path/config.yaml
bridge setup full --config /absolute/path/config.yaml
bridge config check --config /absolute/path/config.yaml
bridge config get --config /absolute/path/config.yaml --key profiles.primary.admission --json
bridge config edit --config /absolute/path/config.yaml
bridge config set --config /absolute/path/config.yaml \
  --key profiles.primary.media.sendOutputFiles --value-json true
```

Quick setup uses schema defaults for advanced fields. Full setup exposes every
currently supported field for the initial Profile and its selected QQ/WhatsApp
accounts, including enablement, account epoch, access rules, admission, approval,
media, paths and Supervisor timeouts. Both validate the canonical YAML, preview
filesystem changes, and require confirmation before writing. They can enter QQ
secrets without echo and optionally invoke the same service installation/start
operations as the direct CLI. Workspace and Codex home must already exist;
setup creates owner-only Bridge state and configuration directories. It never
installs Node or Codex or copies account authentication.

`config set` prints a preview and full confirmation digest. Repeat the same
command with `--confirm DIGEST` to save from a script. Interactive terminals can
confirm the displayed plan. Saving validates the complete candidate plus current
environment overrides, locks the file, detects stale edits, and replaces it
atomically. It does not apply a runtime change. `config edit` opens one executable
from `--editor`, `VISUAL`, `EDITOR`, or the platform default; shell commands and
editor arguments are not evaluated. Existing configuration must be owner-only.

Apply saved settings explicitly:

```sh
bridge config apply --config /absolute/path/config.yaml --endpoint /absolute/path/control.sock
# Repeat with the displayed candidate revision:
bridge config apply --config /absolute/path/config.yaml \
  --endpoint /absolute/path/control.sock --confirm CANDIDATE_REVISION
```

The existing control-plane plan/apply operation decides the affected Profiles and
bounded drain/restart actions. Environment variables still take precedence. A
changed secret is never displayed as its value. Validation failures preserve the
active Configuration Revision; runtime startup failures affect only their Profile.

## Profiles, Channels and secrets

```sh
bridge profile list --config /absolute/path/config.yaml
bridge profile status --profile primary --endpoint /absolute/path/control.sock
bridge profile disable --profile primary --config /absolute/path/config.yaml
bridge profile set --profile primary --key admission.mode --value-json '"queue"' --config /absolute/path/config.yaml
bridge channel list --profile primary --config /absolute/path/config.yaml
bridge channel set --profile primary --account qq-primary --key enabled --value-json false --config /absolute/path/config.yaml
bridge channel status --profile primary --account qq-primary --endpoint /absolute/path/control.sock
bridge channel disconnect --profile primary --account qq-primary --endpoint /absolute/path/control.sock
bridge channel connect --profile primary --account qq-primary --endpoint /absolute/path/control.sock
bridge secret set --profile primary --name QQ_BOT_APP_SECRET --config /absolute/path/config.yaml
```

`profile/channel set`, `enable`, and `disable` use the same configuration edit
operation and confirmation digest. Save, then use `config apply`. Add complete
Profiles or accounts with `config set` or `config edit`; all configured Profile
directories must exist and pass canonical validation. Disabled data and bindings
are preserved. `profile purge` retains its separate destructive confirmation.

`channel connect/disconnect` acts immediately through the selected Profile worker.
Both QQ and WhatsApp are supported. Pending work or delivery prevents lifecycle
changes; disconnect preserves authentication and history. QQ reconnect uses only
that adapter; it never revokes Tencent developer credentials. The status output
shows each adapter separately, including when another adapter is still degraded.

Secrets accept hidden terminal input, `--stdin`, `--from-env NAME`, or
`--from-file /absolute/path`; choose exactly one source. Values are never CLI
arguments. The validated operation writes the selected Profile's `secrets.env`
with locking, flush and atomic replacement. On Unix it requires owner-only files;
on Windows the existing SID-based ACL contract applies. Persistent secrets reload
on Profile startup or explicit configuration apply. The real process environment
continues to override them. Do not put secrets in shell history or YAML.

WhatsApp retains `bridge whatsapp pair`, `logout`, and `forget-local`; pairing
material is shown only in the initiating interactive terminal. Their existing
quiescence, identity and confirmation contracts remain in force.

## Native models and reasoning

```sh
bridge model list --profile primary --endpoint /absolute/path/control.sock
bridge model get --profile primary --scope thread --thread THREAD_ID --endpoint /absolute/path/control.sock
bridge model set --profile primary --scope thread --thread THREAD_ID \
  --model DISCOVERED_MODEL --effort DISCOVERED_EFFORT --endpoint /absolute/path/control.sock
bridge model get --profile primary --scope defaults --endpoint /absolute/path/control.sock
bridge model set --profile primary --scope defaults --model DISCOVERED_MODEL \
  --effort DISCOVERED_EFFORT --endpoint /absolute/path/control.sock
```

Confirm a displayed selection interactively or repeat it with `--confirm DIGEST`.
The running Profile's App Server supplies the catalog. Thread queries use native
`thread/read` without resuming; updates use capability-verified
`thread/settings/update` and apply to subsequent Turns. The target must belong
to that Profile's Workspace. Default settings use native `config/read` and
`config/batchWrite` with the active user-layer version. They affect native future
Thread defaults; they do not change existing Threads.

The CLI returns requested values, observed values and `verified`. An unconfirmed
readback exits 2; inspect native settings before retrying an uncertain write.
Higher-precedence native configuration can mask a successful defaults write.
Unsupported capabilities fail explicitly. The Bridge does not store a parallel
model choice, print raw native configuration, or create a second App Server.

## Service lifecycle

```sh
bridge service install --config /absolute/path/config.yaml --name codex-channel-bridge
bridge service start --name codex-channel-bridge
bridge service status --name codex-channel-bridge --json
bridge service restart --name codex-channel-bridge
bridge service stop --name codex-channel-bridge
bridge service uninstall --name codex-channel-bridge
```

Install and uninstall preview exact paths and require their full digest in
`--confirm` for scripts. Installation does not start the service. Existing
registrations are not overwritten. The service uses the executing Node path,
explicit configured Codex executables, and a displayed service PATH containing
their directories and native system directories. Transient configuration
overrides must first be persisted into the intended YAML. Keep secrets in the
Profile's secret boundary; the interactive shell's secret environment is not
copied into service metadata.

| Host | Backend and startup | Runtime identity |
| --- | --- | --- |
| macOS | LaunchAgent at login | Current user |
| Linux | systemd user unit at user-manager startup | Current user; boot without login requires administrator-enabled linger |
| Windows | Native SCM service, automatic at boot | Explicitly previewed current Windows identity; no switch to LocalSystem |
| Docker | Existing foreground container entry point | Container identity; manage container lifecycle externally |

Windows uses the bundled PowerShell/.NET SCM adapter, not a scheduled task.
Installation requires an elevated terminal **as the same selected identity**,
SCM create permission, a service-logon password, and the account's `Log on as a
service` right. CLI code does not grant that right or change the machine's global
execution policy. Enter the password without echo, or use `--password-stdin` or
`--password-from-env NAME`; it is passed to native service creation over stdin
and is never saved in metadata or command arguments. A denied elevation preserves
configuration and asks the operator to rerun the same command in the proper
terminal. The adapter translates stop to the Supervisor's stdin drain signal;
a Job Object bounds descendant cleanup after the configured timeout.

Status separates registration, service process state, Supervisor liveness, and
Profile readiness. A live Supervisor with an unavailable Profile is reported as
such. Stop/restart wait for Supervisor exit; uninstall preserves configuration,
Profile data, authentication, Workspaces, Codex homes and retained operational
logs. Platform collection owns log rotation. Native Windows SCM acceptance remains
a distinct gate; compilation or ordinary-user IPC success cannot establish it.

## Dashboard and maintenance

```sh
bridge dashboard --endpoint /absolute/path/control.sock --open
bridge status --endpoint /absolute/path/control.sock
bridge doctor --profile primary --endpoint /absolute/path/control.sock
```

Dashboard remains loopback-only and uses its launch-scoped browser capability.
`--open` launches the local browser; keep the terminal running and stop it with
Ctrl+C. Avoid recording the capability URL. Existing backup/restore, migration,
archive purge, Profile purge, audit, support bundle and circuit commands remain
available through `--help` with their original confirmations and authorization.
`doctor` remains read-only. Commands do not wait for confirmation outside a TTY;
scripted mutations require the applicable explicit confirmation and secret source.

Run Unix terminal acceptance with `python3 scripts/cli-interactive.contract.py`.
Run the Windows native adapter compilation/argument contract with
`powershell -File packages/platform/windows/service-compile.contract.ps1`.
