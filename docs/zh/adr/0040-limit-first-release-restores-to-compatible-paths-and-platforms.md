# 将首版 Restore 限制在兼容路径和平台

首版不承诺跨操作系统或任意路径的 Backup Portability。受支持的 Restore 必须保留 Profile ID、操作系统家族、Codex home 与 Workspace 绝对路径、兼容 Codex 版本、Ownership、Permission 和外部 Credential；只有重新建立这些 Invariant 时，才允许迁移到另一台同平台主机，而 Docker 必须保留相同的容器内路径。Bridge 绝不重写 Codex Rollout JSONL、私有 SQLite Table、Thread ID 或持久化 cwd 值来伪造可移植性；更广泛的迁移需要 Codex 官方机制和后续 ADR。
