# Windows execution options without repeated elevation

- Research date: 2026-09-09 (Asia/Shanghai).
- Status: the user requires unattended operation and has authorized a separate
  Windows development branch when no suitable authorization-free route is
  established. Subsequent work is scoped to `codex/windows-unattended`.
  Alternative backends remain design candidates, not implemented or accepted.
  No Windows service, task, account, or ACL was changed for this research.
- Ownership: Bridge-owned host startup and Supervisor lifecycle. This changes
  neither Codex ownership nor the administrator-supplied Codex prerequisite.

## Recommendation

The user requires operation **with nobody logged in**. Foreground execution,
interactive-token login tasks and Startup shortcuts do not meet that requirement;
retain `bridge supervisor run --config PATH` only as a development/debugging tool.

The researched mechanisms provide no general unattended Windows deployment
route that guarantees zero initial system authorization. SCM installation and
Task Scheduler boot-trigger creation require administrator provisioning;
password-free S4U execution still depends on batch-logon policy. One-time
administrator provisioning with precisely delegated service controls can reduce
routine elevation; a virtual service account can remove manually supplied
service passwords, but does not remove administrator setup or policy checks.
[Service access rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights),
[boot-trigger restriction](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger),
[task logon policy](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks),
[virtual accounts](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-service-accounts).

Continue unattended native Windows integration on `codex/windows-unattended`.
Evaluate one-time provisioning there instead of
blocking the macOS/Linux release, repeating interactive password retries, or
introducing several replacement backends.

This is a project recommendation inferred from the Windows contracts below.
Keep the existing test service and retained data under their existing
ownership checks; do not install another copy or start competing Supervisors.
An SCM request must never silently become a login task.

The [current host check](https://github.com/mwe-support/codex-channel-bridge/blob/63d27f269cd355a90d72d6af386572fdcf4aec45/acceptance/windows-backend-readonly-20260909.json)
reports the test service as **Running**, superseding the earlier Stopped snapshot.
Supervisor/Profile readiness was not established. The ordinary token can query
configuration/status but receives Win32 5 for start/stop. No service action or
ACL change was performed by that probe. Scheduler COM access was readable, but
task registration permission was not tested.

## Comparison

“No password” below means no additional Windows password for launching or
registering the workload; it does not remove the user's normal sign-in or
Codex/Channel authentication. Existing filesystem and host policies still apply.

| Path | Additional password / service-logon right | Initial administrator operation | Logged out or before anyone signs in | Network and practical limit |
|---|---|---|---|---|
| Ordinary-user foreground process | Neither; uses the caller's existing token | None for a program and paths already accessible to that user | No interactive-session survival guarantee; logoff terminates session processes | Uses existing user permissions; terminal/process lifetime must be managed. [Task security](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks), [logoff](https://learn.microsoft.com/en-us/windows/win32/shutdown/logging-off) |
| Current-user login task, `InteractiveToken`, least privilege | Neither; no new service logon | Normally none when registering for the current user at low privilege; task policy/ACL can still reject it | No; an existing interactive session is required | Uses the logged-in user's context. Does not have S4U's documented network restriction. This is login automation, not SCM. [Registration security](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks), [logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type) |
| Current-user Startup folder shortcut | Neither; ordinary user launch | None when that user's Startup folder and target are writable/accessible | No; triggered at user sign-in, with the same session lifetime | Simplest login launcher; no service lifecycle or recovery contract. The all-users folder is a different scope. [Startup apps](https://support.microsoft.com/en-us/office/automatically-start-an-office-program-when-you-turn-on-your-computer-4a42ed45-c064-47b6-b497-119c870f7bab), [logoff](https://learn.microsoft.com/en-us/windows/win32/shutdown/logging-off) |
| Administrator-preinstalled SCM service with narrowly delegated local start/stop/status | Operator need not re-enter service credentials for each control operation; a conventional service user still needs its password and service-logon right | Yes: installation, account provisioning and service-object permission delegation | Yes in the Windows service model, subject to successful startup | Changes who may control the service, not its execution identity or network credentials. [Service rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights), [service accounts](https://learn.microsoft.com/en-us/windows/win32/ad/about-service-logon-accounts), [services](https://learn.microsoft.com/en-us/windows/win32/services/services) |
| SCM service using `NT SERVICE\<service-name>` virtual account | No operator-managed password; service-logon policy can still block it | Yes: service installation, identity/path ACL provisioning and policy checks | Yes in the service model, subject to successful startup | Domain resource authentication uses the machine account, not the interactive user. Proxy/network policy and local access must be validated. [Virtual accounts](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-service-accounts), [Microsoft's virtual-account failure cases](https://learn.microsoft.com/en-us/power-automate/desktop-flows/troubleshoot), [services](https://learn.microsoft.com/en-us/windows/win32/services/services) |
| WSL2 / Linux container deployment on Windows | No Bridge Windows-service password or `SeServiceLogonRight` inside Linux; Linux identity and permissions remain | WSL enablement normally requires administrator PowerShell and restart; container-engine provisioning is separate | Not established by choosing WSL or a container. Host startup and instance/engine lifetime need their own acceptance | Adds VM/container networking and storage boundaries. WSL defaults to NAT; inbound access, VPN/proxy and firewall behavior differ. [WSL installation](https://learn.microsoft.com/en-us/windows/wsl/install), [WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking) |

## Limits that matter for the decision

Creating a task with a **boot trigger requires membership in Administrators**.
Its execution identity is a separate decision: adding a boot trigger does not
make an `InteractiveToken` task runnable without a logged-in user.
[BootTrigger](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger),
[task logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type).

`S4U` can execute noninteractively without storing a password, but both S4U and
password-based tasks require `SeBatchLogonRight`. Registration success alone is
insufficient: Windows can report `SCHED_S_BATCH_LOGON_PROBLEM` for a registered
task whose identity lacks that right.
[Task security](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks),
[registration result codes](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itaskfolder-registertaskdefinition).

Microsoft describes S4U's restriction as no network or encrypted-file access.
This security-context restriction must not be restated as proof that every
unauthenticated TCP/HTTP request is blocked: the cited documentation does not
test Bridge's application-token HTTP/WebSocket traffic. Windows-authenticated
resources and encrypted files cannot be assumed available; actual endpoint,
proxy and credential behavior would need acceptance under that exact task
identity. S4U therefore supplies neither a verified online Bridge solution nor
an escape from initial boot-trigger authorization and logon policy.
[Logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type),
[S4U local impersonation context](https://learn.microsoft.com/en-us/archive/msdn-magazine/2007/october/windows-with-c-task-scheduler-2-0).

A time-triggered S4U task is distinct from a boot-triggered task. It may be
registered for the caller without a password when the documented prerequisites
hold; this research does not prove it impossible. Its batch-logon rights,
restart scheduling, credentials, network and graceful-stop behavior have not
been accepted on this host, so it is not a completed replacement.
[Task registration security](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks).

The Win32 service API explicitly supports virtual accounts on Windows 7 and
later clients as well as the corresponding server platforms, with a null
service password. This is a candidate for removing manual password provisioning,
not a removal of the SCM creation permission or a verified Bridge deployment.
[CreateServiceW](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-createservicew).

Delegating SCM control is an authorized permission change, not a permission
bypass. A future implementation should request only the service rights each
operation actually needs and retain identity verification. Do not grant
`SERVICE_CHANGE_CONFIG`, broad write rights, or service-binary replacement
access to solve ordinary start/stop. Account changes also require rechecking
access to configuration, Profile data, Codex home and Workspace.
[Service rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights),
[service-account maintenance](https://learn.microsoft.com/en-us/windows/win32/ad/about-service-logon-accounts).

WSL/container execution is a Linux deployment alternative, not native Windows
SCM acceptance. Microsoft's systemd announcement explicitly says systemd
services do not keep a WSL instance alive. Its current container tutorial now
describes prerelease `wslc.exe`, not a guarantee about Docker Desktop's unattended
lifetime. No Docker-specific password, elevation or logoff guarantee was
established from this Microsoft-only research. Avoid adding or upgrading WSL or
a container engine solely to escape the Windows service provisioning problem.
[WSL systemd lifetime](https://devblogs.microsoft.com/commandline/systemd-support-is-now-available-in-wsl/),
[current WSL container tutorial](https://learn.microsoft.com/en-us/windows/wsl/tutorials/wsl-containers).

## Minimum follow-up

1. Preserve the current Windows work and its acceptance evidence on a separate
   Windows development branch; do not label the existing registration
   as completed unattended support.
2. Develop one administrator-approved provisioning operation with explicit
   identity, path ACLs and narrowly delegated service controls. Evaluate a
   virtual account only within that design, including Codex/Profile access.
3. Accept startup before login, operation after logoff, native Codex readiness,
   Channel delivery, bounded stop/restart and persistence on the real host.
   Foreground or login-only tests cannot substitute for those conditions.
