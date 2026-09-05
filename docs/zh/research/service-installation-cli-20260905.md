# 交互式服务安装与生命周期 CLI

- 研究日期：2026-09-05（Asia/Shanghai）。
- 范围：官方文档与固定提交的上游源码；未复用上游代码，未执行安装、服务注册或平台验收。
- 状态：供 **Next** 设计讨论使用，对应 FR-013；下列建议命令尚不是 Bridge 已发布能力。
- 归属：Bridge 负责自身的宿主安装与 Supervisor 生命周期。宿主管理员提供 Codex
  可执行文件；Codex 负责认证、配置和 App Server 行为。本方案不增加 Codex 行为或
  gateway 运行时依赖。

## 固定的上游证据

| 项目 | 检查的源码提交 | 公开文档 |
|---|---|---|
| Nous Research Hermes Agent | [`2e24e06e5513fa425ccf935d2e41991cb11ff383`](https://github.com/NousResearch/hermes-agent/commit/2e24e06e5513fa425ccf935d2e41991cb11ff383) | [原生 Windows](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native) |
| OpenClaw | [`242717822e2c9641b71bff9d71c8643a3ab48063`](https://github.com/openclaw/openclaw/commit/242717822e2c9641b71bff9d71c8643a3ab48063) | [Gateway CLI](https://docs.openclaw.ai/cli/gateway)、[Windows](https://docs.openclaw.ai/platforms/windows)、[快速入门](https://docs.openclaw.ai/quickstart) |

这些是已检查的 main 分支快照，不代表发行版兼容性承诺。公开文档可能与这些快照存在差异。

## 已核实的上游做法

**Hermes 源码事实：** `hermes gateway` 提供 `run`、`install`、`start`、`stop`、
`restart`、`status`、`uninstall`。安装过程分别提供立即启动、登录启动选项；Linux
另支持 `--system` 与 `--run-as-user`。setup 的消息平台步骤调用共享的
`ensure_gateway_service(context="setup")`。
来源：[CLI 解析器](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/subcommands/gateway.py#L36-L105)、
[setup 集成](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/setup.py#L681-L688)。

**Hermes Windows 源码事实：** 计划任务使用登录触发器、交互式用户令牌和
`LeastPrivilege`。安装器先询问是否立即启动、是否登录启动，再处理提权。
该快照会向非管理员提供 UAC 交接选项；拒绝后使用 Startup 文件夹中的登录启动项。
立即手动启动则使用共享的隐藏控制台进程启动器。这是登录启动，不是 Windows SCM 系统服务。
来源：[任务定义](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/gateway_windows.py#L415-L508)、
[选项与安装](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/gateway_windows.py#L676-L820)、
[手动启动](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/gateway_windows.py#L1225-L1250)。

**文档与源码差异：** Hermes 公开的 Windows 指南仍描述无需管理员的计划任务安装和
`pythonw.exe` 启动器；检查的实现会先向非管理员提供 UAC，并使用隐藏控制台的
`python.exe`。不能把指南中笼统的免管理员说法作为已核实的实现保证。
来源：[公开指南](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native)、
[启动器说明](https://github.com/NousResearch/hermes-agent/blob/2e24e06e5513fa425ccf935d2e41991cb11ff383/hermes_cli/gateway_windows.py#L526-L558)。

**OpenClaw 源码事实：** 服务适配在 macOS 选择 launchd、Linux 选择 systemd
用户服务、原生 Windows 选择计划任务。非交互式 onboarding 开启 `installDaemon`
后构造安装计划并调用同一个 `service.install` 操作；未开启则直接返回而不安装。
公开快速入门提供 `openclaw onboard --install-daemon`；gateway CLI 也提供独立安装
以及 start/stop/restart/status/uninstall 命令。
来源：[服务适配选择](https://github.com/openclaw/openclaw/blob/242717822e2c9641b71bff9d71c8643a3ab48063/src/daemon/service.ts#L374-L431)、
[onboarding 调用](https://github.com/openclaw/openclaw/blob/242717822e2c9641b71bff9d71c8643a3ab48063/src/commands/onboard-non-interactive/local/daemon-install.ts)、
[快速入门](https://docs.openclaw.ai/quickstart)、[CLI 参考](https://docs.openclaw.ai/cli/gateway)。

**OpenClaw Windows 源码事实：** 安装过程注册任务 XML 并运行任务；符合条件的注册
失败会创建并启动当前用户的 Startup 项。该后端不是 SCM。官方 Windows 指南另支持
WSL2 这一独立的 Linux 运行路径；其登录前启动 WSL 的方案包含单独由管理员创建的
Windows 开机任务。
来源：[任务安装与后备路径](https://github.com/openclaw/openclaw/blob/242717822e2c9641b71bff9d71c8643a3ab48063/src/daemon/schtasks-install.ts#L220-L306)、
[Windows 指南](https://docs.openclaw.ai/platforms/windows)。

**Windows 平台契约：** 低权限进程可以注册低运行级别的计划任务，但具体操作仍受任务
身份、凭据和 ACL 限制。创建真正的系统服务需要 `SC_MANAGER_CREATE_SERVICE`
权限。CLI、PowerShell 包装或 UAC 启动均不会消除这些要求；弹出提权窗口不代表注册成功。
来源：[计划任务安全上下文](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)、
[SCM 访问权限](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)。

## 供讨论的 Bridge 设计

当前 Bridge setup 仅写入规范配置，Windows 安装器默认将已校验的发行版安装到用户的
本地应用数据目录。CLI 尚无服务管理命令。注册服务时必须核实选定运行身份对 Node、
Codex、配置及 Profile 路径的访问权限，并保护可执行文件/配置路径，避免比服务权限
更低的身份修改它们。不能假设交互终端的 PATH 或凭据环境变量会出现在服务环境中。
候选 `5c128369` 的本地证据：[setup](https://github.com/mwe-support/codex-channel-bridge/blob/5c12836960050aec3c44acf76ad73c0ff5c41cef/packages/cli/src/setup.ts)、
[CLI](https://github.com/mwe-support/codex-channel-bridge/blob/5c12836960050aec3c44acf76ad73c0ff5c41cef/packages/cli/src/main.ts)、[Windows 安装器](https://github.com/mwe-support/codex-channel-bridge/blob/5c12836960050aec3c44acf76ad73c0ff5c41cef/install.ps1)、
[部署契约](../deployment.md)。

复用现有 `bridge supervisor run --config PATH` 前台入口与 Supervisor 层级，新增一组
宿主本地命令：

```text
bridge service install --config PATH
bridge service start
bridge service stop
bridge service restart
bridge service status
bridge service uninstall
```

`bridge setup quick` 与 `bridge setup full` 应在配置校验后提供服务注册、立即启动
选项，调用与 `bridge service install` 相同的安装操作。保留仅配置、稍后注册的选择；
不新增第二个守护进程或 gateway 别名。

预览应列明后端、开机或登录启动行为、服务身份、可执行文件及配置路径，以及确切的
文件/注册变更，确认后执行。Windows 上，用户请求 SCM 服务就仍然注册 SCM 服务：
说明所需管理员权限，并给出可在管理员终端执行的具体命令。UAC 交接可作为后续便利
功能；提权前后保留选定的运行身份和 Profile 路径，绝不静默改为 LocalSystem 或
提权用户的 Codex home。取消时保留已完成的配置，并明确报告服务尚未注册。登录任务
应是另行命名、经过契约确认的部署选项，不能在 SCM 注册失败后静默降级。

每个部署仍只注册一个 Supervisor；停止、重启、卸载均遵守有界排空。卸载只移除服务
注册，保留配置、Profile 数据、Workspace 和 Codex home。分别报告注册状态、进程存活
与 Profile 就绪，执行后回读核实注册及启动；`status` 保持只读。缺少 Node.js 或 Codex
属于可操作的前置依赖错误，不构成安装它们的授权。

本记录只提出 CLI 设计建议。实现与原生生命周期验收仍是后续工作，包括在真实 Windows
上使用具有所需权限的账户注册 SCM 服务。
