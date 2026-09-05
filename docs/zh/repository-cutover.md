# 仓库切换

状态：已于 2026-08-26 完成。

切换完成时，此目录成为 `main` 上的独立仓库，初始没有 Remote；之后可由用户指定独立仓库的 Remote。它从 Legacy Commit `0060ee641de85708114f7daf305bcf7700d7de90` 对应的 Detached Exploratory Worktree 中切出；旧 Remote 和 History 均未保留。本清单继续作为切换记录，也作为审计或重现该边界的操作步骤。

## 保留内容

更改旧 `.git` Link 前，以下文件已复制到经过验证的 Staging Location；在有意于切换后更新本清单状态之前，它们的 SHA-256 Digest 均匹配：

- `AGENTS.md`
- `CONTEXT.md`
- `docs/adr/`
- `docs/research/codex-native-thread-history-retrieval-and-compaction.md`
- `docs/research/github-codex-channel-bridge-landscape.md`
- 本清单

## 替换或创建

- 将继承的 `README.md` 替换为 Codex Channel Bridge README。
- 创建 ADR 0006 选择的 Apache-2.0 `LICENSE`。
- 创建用于项目归属说明的 `NOTICE`；只有实际决定逐文件复用 Legacy Source 后，才加入对应归属信息。
- 创建项目专用 `.gitignore`。

## 排除内容

以下继承路径没有复制到独立仓库：

- `plugins/`
- `deploy/`
- `mcp/`
- `scripts/`
- 继承的 `README.md`
- `docs/architecture.md`
- `docs/development-log.md`
- `docs/macos-hermes-codex-deployment.md`
- `docs/operations.md`

原始 Hermes Checkout 仍是参考来源。不要在新仓库内创建 Legacy-code Mirror。

## 已使用的操作步骤

1. 重新扫描 Worktree，并把每个路径与保留、替换和排除清单核对。如果未分类文件包含独有工作，立即停止。
2. 把保留文件复制到 Worktree 之外的 Staging Location，并记录 SHA-256 Digest。
3. 解析准确的 Linked-worktree Git Directory，只为追溯来源记录当前 Branch、Commit 和 Remote。
4. 只移除 Linked-worktree Association；绝不 Reset 或删除 Parent Hermes Repository。
5. 重新创建项目路径，只恢复保留文件，并验证每一个 Digest。
6. 暂存前编写替代 README、LICENSE、NOTICE 和 `.gitignore`。
7. 在没有 Remote 的 `main` 上初始化新仓库。检查完整 Staged File List，确认不存在排除路径或 Credential。
8. 创建一个 Design-baseline Commit。只有用户提供独立仓库 Destination 后才配置 Remote。

## 完成标准

- `git branch --show-current` 返回 `main`。
- `git remote -v` 不返回任何 Entry。
- Repository History 只包含新项目基线和后续项目 Commit。
- 保留文件的 Digest 与切换前记录匹配。
- 没有跟踪任何被排除的 Legacy Path。
- README、LICENSE、NOTICE 和 `.gitignore` 描述独立项目。
- 搜索 Hermes 或 OpenClaw Reference 时，只返回有意保留的 Architecture Rationale、ADR、Research Citation 或 Attribution，绝不出现 Runtime Import、Deployment Dependency 或 Installation Instruction。
