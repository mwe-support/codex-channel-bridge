# Hermes Dashboard 运维覆盖点：有限范围参考

日期：2026-09-04。范围：**Next** 的设计参考，不代表 Bridge 已发布版本已经提供这些功能。

## 证据与限制

本次检查官方 `NousResearch/hermes-agent` 的
[`fcbd1076a93841fa88855acce810e342a5b78101`](https://github.com/NousResearch/hermes-agent/tree/fcbd1076a93841fa88855acce810e342a5b78101)
源码（本机 checkout，`v0.20.5` 发布提交，提交日期 2026-08-21）。本地唯一修改是无关的
`tools/send_message_tool.py`；下列引用文件均未修改。这是固定快照，不代表最新 Hermes。
没有读取正在运行的 Hermes 配置、凭证值或日志正文，也没有执行 Hermes 生命周期操作。

## 实现实际提供了什么

| 页面 | 固定源码行为 | 应保留的区别 |
| --- | --- | --- |
| 配置 | 按 Profile 选择的表单和原始 YAML 编辑器；raw GET 返回实际文件路径，raw PUT 替换整个映射，表单 PUT 合并提交字段。 | 显示实际目标文件；保存不代表运行时已应用。 |
| API Keys | 与普通配置分开的、按 Profile 选择的 `.env` 键编辑器；通过凭证生命周期代码保存。 | 结构化 Secret 写入器不是原始 `.env` 文本编辑器。 |
| 日志 | agent/errors/gateway 文件选择、级别和组件筛选、有限行数、可选的每五秒刷新。 | 这是文件 tail 轮询，不是 token 流，也不是完整历史搜索。 |
| 重启 | Dashboard 发起显式、指定 Profile 的 gateway restart，并返回操作 PID。 | 操作已启动不等于就绪，之后还要观察目标状态。 |

来源：[原始 YAML 接口](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L15250-L15294)、
[表单保存](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L7645-L7684)、
[Secret 保存](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L7908-L7931)、
[日志 UI](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/web/src/pages/LogsPage.tsx#L24-L150)、
[重启接口](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L4708-L4722)。

### 不能假设 Profile 切换器也会切换日志

此快照的日志接口**没有 Profile 参数**，直接读取
`get_hermes_home()/logs/<允许的文件名>`。前端自动附加 Profile 的接口列表包含
config、env、gateway，但不包含 logs。因此，这份实现**不能证明**统一 Dashboard 已经
具备可切换的各 Profile 日志 tail。可以借鉴页面布局，但 Bridge 必须自行明确并验证日志
范围和隔离。
[后端](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L12348-L12400)、
[前端范围列表](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/web/src/lib/api.ts#L66-L99)。

### 修改何时生效

Hermes 文档说明：配置修改在下一次 agent session 或 gateway restart 生效；Channel
凭证和 enabled 状态在下一次 gateway restart 建立连接。文档另提供 CLI `/reload`，用于
在当前 CLI 进程重新读取 `.env`。这些是不同操作，不是通用热重载。
[配置和 Channel 说明](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/website/docs/user-guide/features/web-dashboard.md#L204-L419)。

源码原子写入 `.env`，随后更新的是**执行写入的进程**的环境。这次赋值本身无法修改另一
个已经运行的 gateway 的进程环境。部分 Hermes 配置消费者会独立刷新，因此既不能笼统
说“所有修改必须重启”，也不能说“保存会重新加载全部配置”。重启 helper 合并正在进行或
刚发起的重复操作，但该接口走立即重启路径，并非 Bridge 的有界 drain 契约。
[环境写入器](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/config.py#L4266-L4298)、
[重启 helper 与 drain 区别](https://github.com/NousResearch/hermes-agent/blob/fcbd1076a93841fa88855acce810e342a5b78101/hermes_cli/web_server.py#L4626-L4749)。

## Bridge 的最小借鉴方案（建议，并非已发布行为）

1. 默认加载当前部署实际 `config.yaml`，显示路径。区分**保存**、**验证**、**应用**，
   显示磁盘版本、运行中的 Configuration Revision，以及受影响的 Profiles。
2. Secret 仍通过现有写入器进入各 Profile 的 `secrets.env`。展示位置和已配置/已变更
   状态，不展示原始凭证文档或已保存值的预览。明确实际进程环境优先于文件；仅重启子进程
   无法更新父进程继承的环境。
3. 对有界、无正文的运行日志视图提供 Profile 筛选，标明来源、时间范围、保留范围/缺口和
   刷新状态。仅有 Dashboard 最近操作记录不等于运行日志。复用平台收集的 Supervisor
   JSON 输出，不另建日志轮转体系，也不展示 Codex 或消息正文。
4. 从现有控制面展示所需动作：无需重启、受影响 Profile 的 drain/restart，或由管理员
   管理的 Supervisor 重启。按钮必须调用获授权的有界生命周期操作、显示影响范围、阻止
   重复点击并等待就绪；不能从浏览器杀 PID 来模拟操作系统服务管理器。

不引入 Hermes runtime、每 Profile 一套 gateway 服务、模型/审批编辑器、任意日志文件
访问，或 YAML 内的凭证镜像。Bridge Profiles 保持独立 Worker，Codex 保持权威，整个
部署仍只有一个 Supervisor 操作系统服务。
