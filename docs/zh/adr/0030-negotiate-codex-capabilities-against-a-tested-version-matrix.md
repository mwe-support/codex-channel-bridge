# 按实际 Codex 能力协商，版本仅作为验证记录

Next 修订，2026-09-05 接受：取消原先的版本下限和固定 CLI/Schema 断言。Codex 由
管理员提供。Profile 启动时从实际可执行文件生成 Schema，验证必要方法，并进行真实
初始化和模型发现。缺失必要能力使该 Profile 失败关闭；缺失可选能力只禁用其增强。
先在稳定接口查找可选方法，再查询实验接口，使方法转为稳定后无需 Bridge 发版适配。

实际版本与 Schema 摘要用于诊断和验收记录，不是准入白名单。保留历史受测快照；其他
组合即使启动探测通过，也标记为 unverified。宿主契约测试使用配置的可执行文件，
不硬性断言某个版本/摘要，也不要求存在可选方法。启动探测不证明全部运行行为，仍需
保留 Turn、审批、恢复及通道验收。不得修改主机 Codex 安装。Docker 为可复现构建
要求构建者显式指定包版本；运行时仍按能力探测，且不自行更新。

来源：[官方 Schema 生成及初始化文档](https://learn.chatgpt.com/docs/app-server#message-schema)
与 [0.153.4 Schema 导出实现](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/src/export.rs)。
