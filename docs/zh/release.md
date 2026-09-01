# 发布与文档版本管理

Codex Channel Bridge 对 Supervisor、CLI、全部 workspace package、部署文件和
文档使用一个仓库级版本。根目录 `package.json` 是唯一版本源；
`package-lock.json`、各 workspace manifest、内部 workspace 依赖版本、
`docs/VERSION` 和 `docs/zh/VERSION` 都是受校验的镜像。

## 版本模型

版本遵循不含 build metadata 的语义化版本：

- `MAJOR.MINOR.PATCH` 表示稳定版。
- `MAJOR.MINOR.PATCH-alpha.N`、`-beta.N` 或 `-rc.N` 表示预发布版。
- `MAJOR.MINOR.PATCH-dev` 表示 `main` 上尚未发布的开发内容，不得创建 tag
  或发布。

在 `1.0.0` 之前，对配置、持久化状态、管理接口、Channel 或二次开发契约的
破坏性变更递增 `MINOR`；`1.0.0` 之后递增 `MAJOR`。向后兼容的能力新增递增
`MINOR`，向后兼容的修复和文档纠错递增 `PATCH`。即使 Bridge 公共 API 没有
变化，只要 tested Codex matrix 或 Profile schema 变化，也必须写入变更日志。

所有 package 始终同步版本。受支持的部署单元是一套 Supervisor 安装，独立
package 版本只会增加兼容组合，不会改善部署。

## 文档一致性保证

某个 release tag 内的文档，是该版本唯一权威的使用手册。Git tag 在同一个
不可变 Git tree 中固定代码、部署文件、中英文文档、变更日志和版本文件。

任何行为或配置变化，都必须在同一个 pull request 中更新对应英文文件及其
`docs/zh/` 中文文件。发布页面的链接必须指向对应 tag，不能指向 `main`。
已发布版本的纯文档纠错也必须发布新的 patch 版本，不能改写已有 tag 或
GitHub Release。

`npm run release:check` 会在 package、lockfile、内部依赖或文档版本不一致时
失败。传入 `--tag=vVERSION` 后，还会要求版本可发布、tag 完全匹配，并且中
英文变更日志都包含该版本条目。

## 发布内容

每个 GitHub Release 包含：

- 附注形式的 `vVERSION` tag；
- 从 `CHANGELOG.md` 提取的 release notes；
- 从该 tag Git tree 生成的 `codex-channel-bridge-VERSION.tar.gz`；
- 该源码包的 SHA-256 校验和；
- 源码包内完整的中英文文档。

首版发布机制不发布 npm package 或容器镜像。Workspace package 是私有实现
单元，已校验的源码包可以完成原生和 Docker 构建。只有在明确所有权、签名、
保留和回滚契约后，才增加新的分发渠道。

## 准备发布

1. 确认目标范围和兼容性影响。把已经完成的条目从 `Unreleased` 移到
   `CHANGELOG.md` 与 `docs/zh/CHANGELOG.md` 的
   `## [VERSION] - YYYY-MM-DD` 下；两种语言必须描述相同变化。
2. 同时更新受影响的中英文运维、用户、Adapter、迁移和开发文档。难以逆转
   的决策必须写 ADR。
3. 同步仓库版本：

   ```sh
   npm run release:prepare -- 0.2.0-rc.1
   ```

4. 审查完整 diff，然后运行确定性的发布门禁：

   ```sh
   npm run release:check -- --tag=v0.2.0-rc.1
   npm run check
   npm run test:control-contract
   npm run test:supervisor-contract
   ```

5. 根据改动路径运行必要的协议、平台和真实 Channel 验收。稳定版必须为它
   声明的每个平台及 provider 能力保留 release-candidate 验收证据。尚未验证
   的目标必须在 release notes 中明确标为不支持或未完成。
6. 提交已审查的发布改动。维护者已配置签名密钥时创建签名附注 tag；否则
   创建普通附注 tag，并明确说明没有签名：

   ```sh
   git tag -s v0.2.0-rc.1 -m "Codex Channel Bridge v0.2.0-rc.1"
   git push origin main
   git push origin v0.2.0-rc.1
   ```

   未签名时使用：

   ```sh
   git tag -a v0.2.0-rc.1 -m "Codex Channel Bridge v0.2.0-rc.1"
   ```

7. GitHub workflow 会重新执行发布门禁，拒绝轻量或版本不匹配的 tag，生成
   源码包与校验和并发布 GitHub Release。对外宣布前必须核验 release notes、
   校验和及可下载文档。

仓库管理员应保护 `main`、把 verification job 设为 merge 前必需检查，并使用
tag ruleset：只有 release maintainer 可以创建 `v*`，且 tag 不允许更新或删除。
仓库设置是代码内门禁的补充，不能替代代码内检查。

## 稳定版与预发布策略

使用 `rc.N` 对计划发布为稳定版的准确 Git tree 做端到端验收。稳定 tag 所指
commit 与已验收候选版之间，只能存在已批准的发布元数据，或已经重新测试的
修复。`alpha` 和 `beta` 可以包含未完成能力，但 release notes 必须列明边界。

禁止通过移动、删除后重建已发布 tag 来修复 release；应发布新的预发布编号或
patch 版本。稳定版发布后，`main` 应进入 `-dev` 版本，避免其文档被误认为已
发布手册。例如发布 `v0.2.0` 后，应立即执行
`npm run release:prepare -- 0.3.0-dev`，并在 `main` 提交这个仅包含版本切换的
改动。

## 升级与回滚

升级前必须阅读跨越的每一段变更日志。若新版本改变 Bridge schema，必须按
[`migrations.md`](migrations.md) 完成显式迁移计划、外部快照和 apply 流程。
只有目标 release 明确声明兼容当前 Bridge schema 时，才能直接降级 binary；
否则必须恢复迁移前快照及此前固定 tag 的版本。

回滚不等于修改 tag。正确做法是停止当前 Supervisor，必要时恢复文档规定的
兼容状态，部署较早的不可变 release，并完成该版本的验收检查。
