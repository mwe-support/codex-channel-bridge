# 允许环境变量覆盖 YAML 配置

在所有部署目标中，环境变量都覆盖匹配的 `config.yaml` 值；无效的策略名称、格式错误的 Allowlist 或不完整的覆盖必须失败关闭，不能回退为 `open`。变更只能通过显式配置应用或重启生效，绝不监视文件。Secret Reference `env:NAME` 先从实际进程环境解析，再从 Profile 本地持久化的 `secrets.env` 解析；`file:/absolute/path` 保留用于 Docker Secret 等仅含单个 Secret 的 owner-only 文件。Bridge 绝不在 Workspace 或当前目录中搜索 dotenv 文件，不执行 dotenv 内容，也不在 `config.yaml` 中保存 Secret；`secrets.env` 是受严格所有权或 ACL 保护并原子更新的明文文件，列为敏感备份材料，并排除在日志、审计、Support Bundle 和 Channel 输出之外。平台凭据存储或应用层加密需要未来 ADR，因为首版不会宣称具备超出文件系统和 OS 用户信任边界的保护。
