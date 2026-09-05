# Bridge 管理 CLI

状态：Next，FR-013；尚未发布。运行 `bridge --help` 或
`bridge <命令组> --help` 查看用法。使用已构建的源码时，把 `bridge` 替换为
`node packages/cli/dist/main.js`。

## 初始化与配置

```sh
bridge setup quick --config /absolute/path/config.yaml
bridge setup full --config /absolute/path/config.yaml
bridge config check --config /absolute/path/config.yaml
bridge config get --config /absolute/path/config.yaml --key profiles.primary.admission --json
bridge config edit --config /absolute/path/config.yaml
bridge config set --config /absolute/path/config.yaml \
  --key profiles.primary.media.sendOutputFiles --value-json true
```

Quick 使用配置 Schema 的高级字段默认值。Full 展示初始 Profile 及所选 QQ/WhatsApp
账号的全部现有字段，包括启用状态、账号 Epoch、访问规则、准入、审批、媒体、路径与
Supervisor 超时。两者都校验同一种规范 YAML、预览文件系统变化，并在确认后写入。
可以通过隐藏输入填写 QQ 密钥，也可以选择调用与直接 CLI 相同的服务注册、启动操作。
Workspace 与 Codex home 必须已存在；setup 创建 owner-only 的 Bridge 状态和配置目录。
它不安装 Node/Codex，不复制账号认证。

`config set` 输出预览和完整确认摘要。脚本重复原命令并添加 `--confirm DIGEST` 才保存；
交互式终端可以确认已显示的计划。保存时校验完整候选配置及当前环境覆盖、锁定文件、
检测过期编辑，并执行原子替换；不会同时应用运行时变化。`config edit` 使用 `--editor`、
`VISUAL`、`EDITOR` 或平台默认编辑器中的一个可执行文件，不执行 shell 命令或编辑器参数。
已有配置文件必须是 owner-only。

保存后显式应用：

```sh
bridge config apply --config /absolute/path/config.yaml --endpoint /absolute/path/control.sock
# 使用显示的候选配置版本重复执行：
bridge config apply --config /absolute/path/config.yaml \
  --endpoint /absolute/path/control.sock --confirm CANDIDATE_REVISION
```

既有控制面的 plan/apply 操作决定受影响的 Profile 及有限时长 drain/restart。
环境变量仍然优先；密钥变化不会显示实际值。校验失败保留当前 Configuration Revision，
运行时启动失败只影响对应 Profile。

## Profile、Channel 与密钥

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

`profile/channel set`、`enable`、`disable` 复用同一配置编辑操作和确认摘要，保存后再执行
`config apply`。通过 `config set` 或 `config edit` 添加完整 Profile 或账号；所有已配置
Profile 目录必须存在并通过规范校验。停用保留数据和绑定；`profile purge` 仍需独立的
破坏性操作确认。

`channel connect/disconnect` 通过所选 Profile worker 立即执行，支持 QQ 与 WhatsApp。
尚有工作或投递时拒绝生命周期变更；断开保留认证与历史。QQ 重连只操作该适配器，不会撤销
腾讯开发者凭据。状态输出分别显示每个适配器，即使其他适配器仍然降级也会更新。

密钥支持终端隐藏输入、`--stdin`、`--from-env NAME` 或 `--from-file /absolute/path`，
一次只能选择一种来源；值不能作为 CLI 参数。校验后的操作通过锁、flush 和原子替换写入
所选 Profile 的 `secrets.env`。Unix 要求 owner-only 文件；Windows 沿用基于 SID 的 ACL
约束。持久密钥在 Profile 启动或显式配置 apply 时重新加载，实际进程环境仍优先。
不要把密钥写入 shell 历史或 YAML。

WhatsApp 保留 `bridge whatsapp pair`、`logout`、`forget-local`；配对材料只在发起操作
的交互式终端显示。原有静默条件、身份验证和确认约束继续有效。

## 原生模型与推理强度

```sh
bridge model list --profile primary --endpoint /absolute/path/control.sock
bridge model get --profile primary --scope thread --thread THREAD_ID --endpoint /absolute/path/control.sock
bridge model set --profile primary --scope thread --thread THREAD_ID \
  --model DISCOVERED_MODEL --effort DISCOVERED_EFFORT --endpoint /absolute/path/control.sock
bridge model get --profile primary --scope defaults --endpoint /absolute/path/control.sock
bridge model set --profile primary --scope defaults --model DISCOVERED_MODEL \
  --effort DISCOVERED_EFFORT --endpoint /absolute/path/control.sock
```

在交互式终端确认，或添加 `--confirm DIGEST` 重复执行。模型目录来自运行中的 Profile
App Server。Thread 查询使用 `thread/read`，不执行 resume；更新使用经能力探测的
`thread/settings/update`，作用于后续 Turn，且目标必须属于该 Profile 的 Workspace。
默认值通过原生 `config/read`、带当前用户层版本的 `config/batchWrite` 操作，作用于原生
未来 Thread 默认值，不改变既有 Thread。

CLI 返回请求值、观测值与 `verified`。无法确认回读结果时退出码为 2；重试不确定的写入前
应先查询原生设置。更高优先级的原生配置可能遮盖成功保存的默认值。不支持的能力会明确
失败。Bridge 不另存模型选择，不输出完整原生配置，也不创建第二个 App Server。

## 服务生命周期

```sh
bridge service install --config /absolute/path/config.yaml --name codex-channel-bridge
bridge service start --name codex-channel-bridge
bridge service status --name codex-channel-bridge --json
bridge service restart --name codex-channel-bridge
bridge service stop --name codex-channel-bridge
bridge service uninstall --name codex-channel-bridge
```

Install/uninstall 预览精确路径；脚本通过 `--confirm` 提交完整摘要。注册不会立即启动，
也不会覆盖已有注册。服务使用当前 Node 的绝对路径、配置中显式指定的 Codex 可执行文件，
以及预览中显示的 PATH（这些可执行文件所在目录及原生系统目录）。临时配置环境覆盖必须先
保存到预期 YAML。密钥留在 Profile 密钥边界内，不把交互式 shell 的密钥环境写入服务元数据。

| 主机 | 后端与启动策略 | 运行身份 |
| --- | --- | --- |
| macOS | 登录时启动的 LaunchAgent | 当前用户 |
| Linux | 用户管理器启动时运行的 systemd user unit | 当前用户；无登录开机运行需要管理员启用 linger |
| Windows | 原生 SCM 服务，随系统自动启动 | 预览中明确选定的当前 Windows 身份，不切换为 LocalSystem |
| Docker | 既有前台容器入口 | 容器身份；在外部管理容器生命周期 |

Windows 使用随项目提供的 PowerShell/.NET SCM 适配器，不是计划任务。安装要求以**同一
选定身份**打开提升权限的终端，具备 SCM 创建权限、服务登录密码和该账号的“作为服务登录”
权限。CLI 不授予该权限，不改变机器全局执行策略。密码通过隐藏输入、`--password-stdin`
或 `--password-from-env NAME` 提供，经 stdin 传给原生服务创建操作，不保存到元数据或命令
参数。提权被拒绝时保留配置，提示操作者在适当终端执行同一命令。适配器把停止请求转换为
Supervisor 的 stdin drain 信号；达到配置超时后由 Job Object 限制后代进程清理。

状态分别报告注册、服务进程、Supervisor 存活与 Profile 就绪情况；Supervisor 存活但某个
Profile 不可用时会如实显示。Stop/restart 等待 Supervisor 退出；卸载保留配置、Profile
数据、认证、Workspace、Codex home 及已保留的运行日志。日志轮转由平台采集端负责。
原生 Windows SCM 验收仍是独立门槛；编译成功或普通用户 IPC 成功不能替代它。

## Dashboard 与维护

```sh
bridge dashboard --endpoint /absolute/path/control.sock --open
bridge status --endpoint /absolute/path/control.sock
bridge doctor --profile primary --endpoint /absolute/path/control.sock
```

Dashboard 仍仅监听 loopback，使用本次启动专属的浏览器 capability。`--open` 打开本地
浏览器；保持终端运行，以 Ctrl+C 停止，避免记录 capability URL。备份/恢复、迁移、归档
清理、Profile purge、审计、支持包、熔断重置等既有命令仍可从 `--help` 找到，原有确认与
授权规则不变；`doctor` 仍只读。非 TTY 环境不会等待确认；脚本变更必须提供相应的明确确认
和密钥来源。

Unix 终端验收：`python3 scripts/cli-interactive.contract.py`。
Windows 原生适配器编译与参数验收：
`powershell -File packages/platform/windows/service-compile.contract.ps1`。
