# Interactive Service Installation and Lifecycle CLI

- Research date: 2026-09-05 (Asia/Shanghai).
- Scope: first-party documentation and pinned upstream source; no upstream code
  reuse, installation, service registration, or platform acceptance performed.
- Status: design input for **Next**, associated with FR-013; proposed commands
  below are not released Bridge capabilities.
- Ownership: Bridge-owned host installation and Supervisor lifecycle. The host
  administrator supplies the Codex executable; Codex owns authentication,
  configuration and App Server behavior. This proposal adds no Codex behavior
  or gateway runtime dependency.

## Pinned upstream evidence

| Project | Inspected source revision | Published documentation |
|---|---|---|
| Nous Research Hermes Agent | [`2e24e06e5513fa425ccf935d2e41991cb11ff383`](https://github.com/NousResearch/hermes-agent/commit/2e24e06e5513fa425ccf935d2e41991cb11ff383) | [Native Windows](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native) |
| OpenClaw | [`242717822e2c9641b71bff9d71c8643a3ab48063`](https://github.com/openclaw/openclaw/commit/242717822e2c9641b71bff9d71c8643a3ab48063) | [Gateway CLI](https://docs.openclaw.ai/cli/gateway), [Windows](https://docs.openclaw.ai/platforms/windows), [Quickstart](https://docs.openclaw.ai/quickstart) |

These are inspected main-branch snapshots, not release compatibility promises.
Published documentation can drift from those snapshots.

## Verified upstream patterns

**Hermes source fact:** `hermes gateway` exposes `run`, `install`, `start`,
`stop`, `restart`, `status`, and `uninstall`. Installation separately exposes
start-now and start-on-login choices; Linux additionally supports `--system`
and `--run-as-user`. The setup messaging step calls the shared
`ensure_gateway_service(context="setup")` helper.
Sources: [CLI parser](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/subcommands/gateway.py#L36-L105),
[setup integration](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/setup.py#L681-L688).

**Hermes Windows source fact:** the task uses a logon trigger, an interactive
user token and `LeastPrivilege`. The installer asks whether to start now and
at login before elevation. At this snapshot a non-administrator is offered a
UAC handoff; declining uses a Startup-folder login entry. Immediate manual
start uses the shared hidden-console process launcher. This is login startup,
not a Windows SCM service.
Sources: [task definition](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/gateway_windows.py#L415-L508),
[choices and installation](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/gateway_windows.py#L676-L820),
[manual start](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/gateway_windows.py#L1225-L1250).

**Documentation/source discrepancy:** Hermes's published Windows guide still
describes a no-admin Scheduled Task install and a `pythonw.exe` launcher.
The inspected implementation offers UAC first on a non-admin account and uses
hidden-console `python.exe`. Do not repeat the guide's blanket no-admin claim
as a verified implementation guarantee.
Sources: [published guide](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native),
[launcher rationale](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/gateway_windows.py#L526-L558).

**OpenClaw source fact:** its service abstraction selects launchd on macOS,
systemd user services on Linux, and Scheduled Tasks on native Windows.
Non-interactive onboarding with `installDaemon` builds an installation plan
and invokes the same `service.install` operation. Without that option it
returns without installing. The documented quickstart exposes
`openclaw onboard --install-daemon`; the gateway CLI also offers direct
installation and the usual start/stop/restart/status/uninstall operations.
Sources: [service registry](https://github.com/openclaw/openclaw/blob/242717822e2c9641b71bff9d71c8643a3ab48063/src/daemon/service.ts#L374-L431),
[onboarding delegation](https://github.com/openclaw/openclaw/blob/242717822e2c9641b71bff9d71c8643a3ab48063/src/commands/onboard-non-interactive/local/daemon-install.ts),
[quickstart](https://docs.openclaw.ai/quickstart), [CLI reference](https://docs.openclaw.ai/cli/gateway).

**OpenClaw Windows source fact:** installation registers task XML and runs the
task; eligible registration failures create and launch a per-user Startup
entry. This backend is not SCM. The official Windows guide also supports WSL2
as a distinct Linux runtime path, including a separate administrator-created
Windows boot task for its documented pre-login WSL startup recipe.
Sources: [task install and fallback](https://github.com/openclaw/openclaw/blob/242717822e2c9641b71bff9d71c8643a3ab48063/src/daemon/schtasks-install.ts#L220-L306),
[Windows guide](https://docs.openclaw.ai/platforms/windows).

**Windows contract:** low-privilege task registration can use a low run level,
but actual task operations remain subject to task identity, credentials and
ACLs. Creating a real service requires `SC_MANAGER_CREATE_SERVICE` access.
A CLI, PowerShell wrapper or UAC launch does not remove those requirements;
opening an elevation prompt does not establish successful registration.
Sources: [Task Scheduler security](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks),
[SCM access rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights).

## Proposed Bridge design for discussion

The current Bridge setup only writes canonical configuration, and the Windows
installer installs verified releases under the user's local application data
directory by default. The CLI has no service management commands. A service
installation must validate its chosen runtime identity's access to Node,
Codex, configuration and Profile paths, and protect executable/configuration
paths from modification by identities less privileged than the service. It
must not assume an interactive shell's PATH or secrets environment is present.
Local evidence at candidate `5c128369`: [setup](https://github.com/mwe-support/codex-channel-bridge/blob/5c12836960050aec3c44acf76ad73c0ff5c41cef/packages/cli/src/setup.ts),
[CLI](https://github.com/mwe-support/codex-channel-bridge/blob/5c12836960050aec3c44acf76ad73c0ff5c41cef/packages/cli/src/main.ts), [Windows installer](https://github.com/mwe-support/codex-channel-bridge/blob/5c12836960050aec3c44acf76ad73c0ff5c41cef/install.ps1),
[deployment contract](../deployment.md).

Reuse the existing `bridge supervisor run --config PATH` foreground entry point
and Supervisor hierarchy. Add one host-local command family:

```text
bridge service install --config PATH
bridge service start
bridge service stop
bridge service restart
bridge service status
bridge service uninstall
```

`bridge setup quick` and `bridge setup full` should offer service registration
and immediate startup after configuration validation. Both invoke the same
installation operation as `bridge service install`. Preserve a configure-only
choice and allow registration later; do not add a second daemon or gateway alias.

The preview must identify the backend, boot-versus-login behavior, service
identity, executable and configuration paths, and exact files/registration
changes. Confirm that plan before applying it. On Windows, a requested SCM
service remains an SCM service: explain required administrator privileges and
provide the concrete command to run from an elevated terminal. UAC handoff may
be a later convenience; preserve the chosen runtime identity and Profile paths
across elevation, never silently select LocalSystem or the elevated user's
Codex home. Cancellation preserves completed configuration and explicitly reports
service registration as incomplete. A login task would be a separately named deployment option requiring
its own approved contract; do not silently downgrade an SCM request to it.

Keep one registered Supervisor per deployment, with bounded drain for stop,
restart and uninstall. Uninstall removes service registration while preserving
configuration, Profile data, Workspaces and Codex homes. Report registration,
process liveness, and Profile readiness separately. Verify registration and
startup after execution; keep `status` read-only. Missing Node.js or Codex is an
actionable prerequisite failure, never authorization to install either.

This note establishes a CLI design recommendation only. Implementation and
native lifecycle acceptance, including real Windows SCM registration under
the required account privileges, remain separate work.
