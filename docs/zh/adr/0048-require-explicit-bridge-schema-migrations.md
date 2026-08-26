# 要求显式执行 Bridge Schema Migration

Bridge 安装与升级仍由 Operator 所有，正常 Service Start 不执行不可逆 Migration：新 Binary 保持 Supervisor Live，同时把受影响 Profile 标记为 `unavailable: migration_required`。System Administrator 必须检查 `bridge migrate plan`、对每个 Target 执行有界 Drain、引用已完成的 Backup Manifest、确认准备好的数据已由外部创建快照，并显式应用 Plan。每个 Profile Database 独立迁移和验证并生成 Audit Record，因此失败不会修改或停止 Sibling；Migration 只能处理 Bridge-owned State，且不提供自动 Down Migration。只有 Release Metadata 明确声明当前 Bridge Schema 兼容时才支持 Binary Downgrade，否则 Rollback 必须先恢复迁移前快照，再运行旧版本。
