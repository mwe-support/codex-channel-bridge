# 减少重复授权的 Windows 运行方式

- 调研日期：2026-09-09（Asia/Shanghai）。
- 用户要求无人登录也能运行，并授权在没有合适免授权路径时将 Windows 后续开发
  独立到分支。后续范围为 `codex/windows-unattended`；替代后端仍是设计候选，
  不代表已经实现或验收。本次调研未改变 Windows 服务、任务、账号或 ACL。
- 归属：Bridge 的宿主启动与 Supervisor 生命周期；Codex 的职责以及由管理员
  提供可执行文件的前提不变。

## 决定与依据

前台窗口、交互令牌登录任务和 Startup 快捷方式均不满足无人登录的要求。
现有 `bridge supervisor run --config PATH` 继续作为开发调试入口。

已调研机制没有提供一种通用、保证零初始系统授权的无人值守部署路径。SCM 创建和
开机触发器要求管理员配置；免密码的 S4U 仍依赖批处理登录策略。一次管理员配置加
精确的服务控制权限可以减少日常提权；虚拟服务账号可以免去手动提供服务密码，
但仍需安装、ACL 与策略配置。
[SCM 权限](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)、
[开机触发器](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger)、
[任务登录策略](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)、
[虚拟服务账号](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-service-accounts)。

Windows 无人值守后续工作在 `codex/windows-unattended` 继续，优先验证一次配置方案，
不继续阻塞其他平台的主线工作，不通过反复输密码或同时增加多个后端推进。
这是基于官方契约与当前验收状态的项目决策，不是声称所有可能方案均不可行。
保留现有代码、服务及数据的归属边界；SCM 请求不能默默变成登录任务。

[当前宿主检查](https://github.com/mwe-support/codex-channel-bridge/blob/63d27f269cd355a90d72d6af386572fdcf4aec45/acceptance/windows-backend-readonly-20260909.json)
显示测试服务已经是 **Running**，早先的 Stopped 快照已过时；Supervisor/Profile
就绪未得到确认。普通令牌可以查询配置和状态，启动、停止则返回 Win32 5。
这次只读探针没有改变服务或 ACL。Task Scheduler COM 可以读取，但没有验证任务
注册权限。

## 方案比较

下表的“免密码”仅指启动或注册工作负载时不额外提供 Windows 密码；用户登录、
Codex 认证、渠道认证和现有文件权限要求仍然存在。

| 方案 | 密码与登录权 | 初始管理员操作 | 无人登录或注销后 | 网络与实际限制 |
| --- | --- | --- | --- | --- |
| 普通用户前台进程 | 使用现有令牌，无服务密码或服务登录权 | 用户已有程序及路径权限时不需要 | 不保证；注销会结束会话进程 | 生命周期依赖终端与会话。[注销契约](https://learn.microsoft.com/en-us/windows/win32/shutdown/logging-off) |
| 当前用户的低权限 InteractiveToken 登录任务 | 无额外密码、无新的服务登录 | 通常不需要；实际受任务 ACL/策略约束 | 需要已存在的交互会话 | 登录自动化，不是 SCM。[任务安全](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)、[登录类型](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type) |
| 当前用户 Startup 快捷方式 | 无额外密码、无服务登录权 | 用户目录可写时不需要 | 仅在登录时启动 | 不具备服务恢复与停止契约；全用户目录是另一范围。[启动项](https://support.microsoft.com/en-us/office/automatically-start-an-office-program-when-you-turn-on-your-computer-4a42ed45-c064-47b6-b497-119c870f7bab) |
| 管理员预装 SCM，精确委派启动/停止/查询 | 日常操作不必重输服务密码；普通服务账号仍有登录前提 | 需要安装、账号准备与服务对象授权 | 服务模型支持，实际启动需验收 | 执行身份和网络凭据不因控制权限改变。[服务权限](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)、[服务登录账号](https://learn.microsoft.com/en-us/windows/win32/ad/about-service-logon-accounts) |
| `NT SERVICE\服务名` 虚拟服务账号 | 无手动密码管理，仍受服务登录策略约束 | 需要安装、身份/路径 ACL 与策略配置 | 服务模型支持，实际启动需验收 | 域资源使用计算机账号；代理与本地文件访问须验证。[账号说明](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-service-accounts)、[虚拟账号故障示例](https://learn.microsoft.com/en-us/power-automate/desktop-flows/troubleshoot) |
| Windows 上的 WSL2/Linux 容器 | Linux 内不使用 Bridge Windows 服务密码或该登录权 | WSL 启用通常需要管理员及重启，容器引擎另行准备 | 不能仅凭采用 WSL/容器就保证 | 增加实例生命周期、存储、NAT/VPN/代理边界。[WSL 安装](https://learn.microsoft.com/en-us/windows/wsl/install)、[网络](https://learn.microsoft.com/en-us/windows/wsl/networking) |

## 关键限制

创建 BootTrigger 任务需要管理员组成员身份。执行身份仍是单独条件，添加开机
触发器不会使 InteractiveToken 任务摆脱登录会话依赖。
[BootTrigger](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger)。

S4U 可免保存密码并非交互运行，但它和密码型任务都需要 `SeBatchLogonRight`。
任务注册成功不等于可启动，Windows 可能返回 `SCHED_S_BATCH_LOGON_PROBLEM`。
[任务安全](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)、
[注册返回码](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itaskfolder-registertaskdefinition)。

微软对 S4U 的描述包含网络及加密文件访问限制。不能由此推断所有不使用 Windows
身份认证的 TCP/HTTP 请求都被禁止：所引文档并未验证 Bridge 的应用令牌 HTTP/
WebSocket 流量。Windows 身份认证资源、加密文件、代理及实际凭据行为必须单独
验收。按时间触发的 S4U 任务也不同于开机触发器：满足前提时，调用者可为自己
免密码注册；本研究没有证明它不可能，但本机的权限、调度恢复、网络、凭据及
有界停止均未验收，因此不算已完成替代方案。
[登录类型](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)、
[注册安全](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)、
[S4U 上下文](https://learn.microsoft.com/en-us/archive/msdn-magazine/2007/october/windows-with-c-task-scheduler-2-0)。

Win32 API 明确支持 Windows 7 及之后客户端和对应服务器平台的虚拟账号，并要求
服务密码参数为 null。这能减少手动密码配置，不移除 SCM 创建权限，也不证明
Bridge 已能在该身份下完成工作。
[CreateServiceW](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-createservicew)。

委派服务控制是明确的权限变更。按实际操作授予最少权限，保留身份核验；不能为了
普通启动/停止而授予配置变更、广泛写入或替换服务二进制的权限。更换运行身份前，
必须重新核对配置、Profile 数据、Codex home 和 Workspace 的可访问性。
[服务权限](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)。

WSL/容器是 Linux 运行路径，不能冒充 Windows SCM 验收。微软指出 systemd 服务
不会使 WSL 实例保持存活；当前容器教程介绍的是预发布 `wslc.exe`，不构成 Docker
Desktop 无人值守生命周期的保证。本次没有通过微软材料建立 Docker 专属的免
授权或注销常驻结论，也不因此安装或升级 WSL/容器引擎。
[WSL systemd 生命周期](https://devblogs.microsoft.com/commandline/systemd-support-is-now-available-in-wsl/)、
[当前容器教程](https://learn.microsoft.com/en-us/windows/wsl/tutorials/wsl-containers)。

## 后续范围

1. 在 Windows 专用分支保留现有工作与证据，不把现有注册等同于无人值守验收通过。
2. 验证一次管理员初始化、明确运行身份、路径 ACL 和精确服务控制权限；虚拟账号
   是该设计内的候选，需同时验证 Codex/Profile 访问。
3. 在真实宿主验证登录前启动、注销后运行、原生 Codex 就绪、渠道投递、有界停止/
   重启与持久化。前台或登录后测试不能替代这些门槛。
