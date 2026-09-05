# Schema 11 回滚演练 — 0.2.0-rc.1

- 日期：2026-09-05，原生 macOS。
- 上一不可变二进制：`v0.1.0-rc.4`，schema 9。
- 候选二进制：`0.2.0-rc.1`，schema 11。
- 范围：不含 Channel Account 的隔离 Profile state；未读取或修改真实测试 Profile
  及其凭证。

从准确的上一 tag 导出源码，在 owner-only 临时目录按其 lockfile 安装并构建，
再用它创建包含一条无害 Archive 记录的 schema-9 Profile store。关闭 SQLite 后
复制为外部快照；源文件与快照 SHA-256 一致。

候选版本的公开迁移 API 规划并执行组合 schema 9→11 路径。检查结果为 schema 11、
`quick_check=ok`。随后上一版本以 `migration_required` 拒绝该数据库，证明直接降级
二进制会 fail-closed。

仅删除迁移数据库生成的 WAL/SHM companion，并用迁移前快照替换数据库后，准确的
上一版本重新打开 schema 9，保留一条 Archive 记录，且 `quick_check=ok`。其完整
Supervisor 使用 Codex CLI 0.149.1 达到 Profile `ready` 和 `supervisor_live`，
随后完成有界 drain 并以 0 退出。

这验证 schema-9 前序版本的文档化回滚方式：恢复预先准备的快照，再启动上一不可变
release。不代表自动 down migration、跨平台恢复或真实生产 Profile 恢复。临时演练
未配置 provider，也没有发送 Channel 消息。
