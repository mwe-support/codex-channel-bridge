# 将 Model 命令投射到原生 Thread Setting

`/model` 和 `/reasoning` 将投射到 Codex App Server，而不是成为 Bridge 自有设置。在首个受测 Codex 版本中，`model/list` 提供 Model Catalog 以及每个 Model 的有序 `supportedReasoningEfforts`；实验性 `thread/settings/update` 可在不创建 Turn 的情况下修改已加载的 Thread，Codex 会为 `thread/resume` 持久化结果。活动 Turn 期间的更新只影响后续 Turn。Bridge 将声明所需的实验性 Capability，维护经过测试的 Codex Compatibility Matrix 和 Generated-schema Contract Test；原生方法缺失时，将这些命令报告为不支持，而不是模拟它们或修改 `config.toml`。
