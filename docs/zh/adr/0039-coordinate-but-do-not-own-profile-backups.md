# 协调但不拥有 Profile Backup

Bridge 将为指定 Profile 提供主机本地的 Backup Prepare 和 Finish 协调，但不创建专有的完整备份包：Prepare 会 Drain Profile、Checkpoint Bridge SQLite、Flush Outbox、停止 Worker 和 App Server，并生成版本化 Verification Manifest。管理员现有的备份工具负责快照其中列出的 Bridge 自有数据、完整 Codex home、可选 Workspace 和单独管理的 Credential Material；Bridge 不复制、解析、转换或重新打包 Codex History 或 Workspace File。Restore 在服务停止时把这些文件放回原位，并且 Worker 启动前必须通过 Bridge Validation；首版不承诺在所有 Ownership Domain 之间实现在线一致备份。
