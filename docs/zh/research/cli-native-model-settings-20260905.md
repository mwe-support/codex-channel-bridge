# Bridge CLI 的 Codex 原生模型与推理设置

- 调研日期：2026-09-05（Asia/Shanghai）。
- 归属：模型发现、Thread 设置和 Codex 配置属于 Codex。Bridge CLI 通过选定的
  Profile worker 投影原生方法，不另存一套模型选择。
- 证据：从终端 `PATH` 解析的管理员提供的可执行文件、生成的稳定/实验 Schema、
  官方文档及[上游快照 `ddf04ad26789d040f9ef6a96736f76602e35a6cc`](https://github.com/openai/codex/commit/ddf04ad26789d040f9ef6a96736f76602e35a6cc)。
  上游 main 是实现证据，不能证明它与已安装可执行文件完全同源；每个真实 Profile
  的配置可执行文件仍须分别执行 Schema 和运行时能力检查。

## 本机可执行文件证据

已有探测器优先使用 Profile 显式配置的 `codexExecutable`，否则使用服务 PATH 中的
`codex`。本次调研使用终端 PATH 回退，没有读取在线 Profile 配置、Codex home 或认证材料。

```sh
codex --version
codex app-server generate-json-schema --out /tmp/codex-cli-native-settings-stable-20260905
codex app-server generate-json-schema --experimental --out /tmp/codex-cli-native-settings-experimental-20260905
```

三条命令退出码均为 0，版本为 `codex-cli 0.153.4`。沙箱提示无法创建 PATH 别名，
但 Schema 生成成功。`codex_app_server_protocol.v2.schemas.json` 的 SHA-256：

| 接口面 | SHA-256 |
| --- | --- |
| 稳定 | `d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a` |
| 实验 | `e5f798fd1343c539f01fedea0e8a84a43c080fcca4615c80eb04a5edab4f7d0a` |

摘要只标识证据，不是兼容性门槛。调研阶段未启动 App Server，未执行模型请求、Thread
修改或配置写入；真实终端验收属于后续实现工作。

## 最小原生字段

| 操作 | 请求 | 相关响应 |
| --- | --- | --- |
| 模型发现 | `model/list {cursor?, limit?, includeHidden?}` | `data[]`、`nextCursor`；条目含 `model`、`displayName`、`supportedReasoningEfforts`、`defaultReasoningEffort`、`isDefault` |
| 查询 Thread 设置 | `thread/read {threadId, includeTurns:false}` | `thread.model`、`thread.reasoningEffort`、`thread.modelProvider` |
| 修改 Thread 设置 | `thread/settings/update {threadId, model?, effort?}` | `{}` 及原生 `thread/settings/updated` 通知 |
| 查询默认值 | `config/read {includeLayers:true, cwd?}` | `config.model`、`config.model_reasoning_effort`、`origins`、`layers` |
| 修改单个默认值 | `config/value/write {keyPath, value, mergeStrategy:"replace", expectedVersion?}` | `status`、`version`、`filePath`，可选 `overriddenMetadata` |
| 原子修改相关默认值 | `config/batchWrite {edits:[{keyPath,value,mergeStrategy:"replace"}], expectedVersion?, reloadUserConfig:false}` | 同上 |

被检查的可执行文件中，`thread/settings/update` 属于实验接口，其他列出的方法有稳定
请求 Schema。需同时探测两种接口面，避免将来转为稳定后被误判。不能硬编码模型与推理
目录；应分页调用 `model/list`，使用条目返回的 effort 选项。
官方概览：[Codex App Server](https://developers.openai.com/codex/app-server)。

## 作用域与生效时间

**查询不需 resume：** 生成的 `Thread` 将模型与 effort 定义为：已加载时的当前配置，
否则为最近持久化值；null 表示未设置或不可用，不是每个 Turn 的执行遥测。
固定快照的处理器读取持久元数据及可能存在的内存状态，因此查询不必恢复、订阅或创建
Thread。只投影设置字段；`thread/read` 还含私人 preview/path。
来源：[Thread 查询处理器](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/src/request_processors/thread_processor.rs#L2823-L2908)。

**更新影响后续 Turn：** 请求字段明确描述这一时机，官方测试也覆盖在 Turn 活跃时更新
模型并接收通知。处理器提交核心设置操作后返回 `{}`，需要通知或原生回读证明已应用，
不能把空确认当作完整证据。未加载的 Thread 可能需要既有修改/resume 路径；只读查询不需要。
来源：[协议字段](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L226-L278)、
[处理器](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/src/request_processors/turn_processor.rs#L906-L953)、
[活跃 Turn 合约测试](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs#L240-L282)。

**默认值不等于 Thread 更新：** 即使 `reloadUserConfig` 为 true，`config/batchWrite`
也明确不会热重载会话静态的模型与推理默认值。Profile 未来默认值通过该 Profile 原生
配置 API 修改，既有 Thread 通过 Thread 设置方法修改。Bridge Profile 与 Codex
配置中的命名 profile 是不同概念。
来源：[会话默认值处理](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/src/request_processors/config_processor.rs#L151-L175)。

## 配置并发与输出边界

- 写入前重新读取层。`expectedVersion` 是**当前用户层版本**，不是任意键来源或合并
  配置的版本。冲突返回 `ConfigVersionConflict`；应重新读取并预览，不强制覆盖。
- 省略 `filePath` 时选择 Codex 当前用户配置。固定快照拒绝其他路径并返回
  `ConfigLayerReadonly`，因此 CLI 不应暴露任意路径覆盖。用户层可能带 Codex
  config-profile 选择器，存在多个用户层时不能假定第一个就是当前层。
- 相关默认值用一个 batch 写入。高优先级配置遮盖写入时报告 `okOverridden`，并回读
  实际生效值。
- 不输出完整 `config/read`、`layers`、`origins`、原生路径或完整写入响应；只允许模型、
  effort 和无正文的结果元数据，因为其他原生配置可能包含敏感材料。
- 不解析或改写 `config.toml`、私有数据库或 rollout 文件，不为运行中的 Profile 再开
  App Server，也不修改主机 Codex CLI。

来源：[用户层路径与版本检查](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/app-server/src/config_manager_service.rs#L217-L254)。
