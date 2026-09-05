# 按能力判断 Codex 兼容性与准入/投递独立性——Next

- 日期：2026-09-05。最初验收基于 `90e4449f3f4bf84015758be5c97241368acee070`
  的未提交 Next 快照，随后作为候选 `0c8ce805d0b874c527895f195ed3e293c4a8dac2`
  发布到同步分支。不是新版本发布，也不修改不可变的 `0.2.0-rc.1` 产物。
- 生产 TypeScript SHA-256：
  `3d2ff226783356650b3ca07992805d06db0c18a6daedc407e6ed22cb72ef4eb8`。
  对全部 76 个受跟踪的 `packages/**/*.ts` 文件，排除测试、contract 和 `.d.ts`，
  按相对路径排序，依次输入“相对路径、换行、文件字节”。这标识源码，不代表完整分发包。
- macOS 与原生 Linux 上实际使用管理员已安装的 Codex CLI `0.153.4`。
  稳定 Schema SHA-256：
  `d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a`。
  没有修改任何宿主 Codex 安装。

## 改动与自动化反例

AGENTS.md 与 ADR 0028/0030/0052 将安全和职责边界与可调整的算法分开。
检索信号保持不变，因为之前消融去掉 fuzzy 后丢失了标注的错拼目标。

活动 Channel 上下文和 Turn 目标保存在同一记录，队列工作在执行前登记。
回归在修正前因账户活动计数为 0、预期为 1 而失败；修正后验证控制者查找、账户/
参与者边界、排空期间保留和释放清理。准入选择最早可执行项，跳过忙 Thread，
同时保持同 Thread FIFO、总容量与过期规则。

Outbox 复用按账户独立的投递循环。测试覆盖：一个账户领取八条记录后被阻塞，
仍不影响另一账户后到的投递；按账户回收过期租约不回收其他账户的租约；保留
Logical Result 分段顺序和既有重试/重启行为。这些是确定性故障测试，不声称真实制造
了平台故障。

兼容性不再按 CLI 版本下限或 Schema 摘要差异拒绝启动。必要方法和原生初始化/模型
发现决定可用性；未被调用的压缩方法不再是启动要求。可选方法同时从稳定和实验接口
发现。测试覆盖旧、新、预发布与未知版本标签的能力完整 Schema、必要方法缺失失败
关闭、可选方法缺失及晋升。历史快照是证据，不是白名单。0.153.4 显示的 `unverified`
表示未命中内置历史快照清单，不表示启动探测失败。

## 真实 QQ 客户端验收

用户授权使用本机 macOS QQ 客户端、两个提供的 QQ 凭据，为第二个 Profile 复用既有
OpenAI 认证，以及短暂重启 Supervisor 和调整临时测试配置。一个实际 Supervisor
管理两个不同 Worker 与 App Server 进程树，使用独立 Codex home、Workspace、
数据库和 Channel Account。第二个 Codex home 只配置认证材料，没有复制已有
Thread 历史。这仍是同一 OS 用户和 OpenAI 账号下的应用层隔离。

| 场景 | 观察结果 |
| --- | --- |
| 两个 QQ Bot 往返 | 两边客户端均可见回复，持久投递均 accepted |
| 两个 Profile 工作重叠 | 观察到两个 Profile 同时存在活动原生工作，最终独立投递 |
| 次 Profile 活动时中断主 Profile | 主 Profile 进入 `interrupted` 终态；次 Profile 仍为 `started`，随后完成，客户端可见输出且投递 accepted |
| 队列晋升及原生审批 | 主 Profile 的排队输入晋升后出现原生命令审批；同一 Token 从第二个 Profile 回复被拒绝，主请求保持 pending；正确主会话的 decline 记录为 `responded / decline`，审批展示 accepted，Turn 最终完成 |
| 同 Profile 两个 Thread Binding | A1/B1 活动，随后按顺序排入 A2/B2。B1 结束后，B2 在 A1 仍活动、A2 未启动时完成；B2 比 A1 提前 80,587 毫秒完成，A2 只在 A1 结束后启动。客户端输出和持久回执确认完成 |

本轮 16 条带验收标记的输入全部进入终态：15 条 completed、1 条 interrupted。
对应最终投递全部 accepted，真实审批展示也 accepted。未带标记的工作不纳入该场景
计数。使用的是 Bridge 关联时间戳，不作为平台网络延迟测量。

早期一次 QQ 粘贴意外将剪贴板截图附在群聊测试消息中。用户选择保留该消息。
后续场景改用直接键入的 ASCII 文本，并核对草稿。该图片不包含在本报告或仓库中，
也不作为验收证据。

## 平台检查

| 目标 | 准确检查与结果 |
| --- | --- |
| 原生 macOS | `npm run check` 通过 252 项单元、4 项发布工具、4 项平台静态检查；`npm run test:control-contract` 通过 5 项；`test:contract`、`test:supervisor-contract` 使用 Codex 0.153.4 通过；`npm run docs:build` 双语通过 |
| 原生 Linux，`marvel-mini-pc` | Node 22.22.1；隔离目录中 `npm ci`、`npm test`（252 + 4 + 4）、`test:control-contract`（5）、`test:contract`、`test:supervisor-contract` 均通过，使用管理员已安装的 Codex 0.153.4 |
| Linux Docker，`marvel-mini-pc` | 生产 Dockerfile 在显式 `CODEX_VERSION=0.153.4` 下构建成功；非 root 容器使用全新、未认证的 Codex home，原生协议及 Supervisor/Profile 契约通过 |

隔离 Docker 镜像 ID：
`sha256:937abecec91f25772a7a614a856620021131d18bd398957eb2acc1cf5521c9b9`。
镜像明确的包版本用于可复现构建，不是 Bridge 兼容性门槛；另行验证省略版本或提供
`latest` 时均在版本输入校验处失败。运行中的容器不自行更新。

上述 Linux/Docker 检查不证明其真实 QQ 投递，也不代表新一轮
systemd/Windows/launchd 服务安装或全部平台故障模式的验收。

## Windows 后续验收——部分通过，候选尚未全绿

任务读取接口未返回最新轮次正文，因此以下 Windows 结果由用户转交。候选提交为
`0c8ce805d0b874c527895f195ed3e293c4a8dac2`，Tree 为
`5189864d38ff4f5d6210cad4c391935d9295456b`。76 个生产源码文件的 Git Blob 和检出
字节均匹配上方指纹，无 CRLF 差异。独立验收 worktree 在准备测试补丁前是干净的。
宿主为 Windows `10.0.26200`、Node `24.13.0`、npm `11.6.2`、实际 Codex `0.153.4`；
报告的稳定 Schema 摘要也与上方 macOS/Linux 一致。

| 命令 | 退出码 | pass / fail / skip 或结果 |
| --- | ---: | --- |
| `npm ci` | 0 | 安装成功 |
| `npm run check` | 1 | 单元阶段：244 / 4 / 4 |
| `npm run test:control-contract` | 0 | 5 / 0 / 0 |
| `npm run test:contract` | 0 | 原生协议契约通过 |
| `npm run test:supervisor-contract` | 0 | 双 Profile 隔离与停止通过 |
| `npm run docs:build` | 0 | 工具测试 2 / 0 / 0，双语构建成功 |
| `npm run test:release-tool` | 0 | 3 / 0 / 1 |
| `npm run test:platform-contract` | 0 | 静态检查 4 / 0 / 0 |

其中三项是测试缺陷：既有 Operations Inspector 断言预期 `null`，实际 Windows
状态目录 ACL 检查返回 `true`；新增的按账户 Outbox 测试和既有原生流测试把关闭
数据库的钩子注册在删除目录之后，导致 Windows `EBUSY`。最小修复只改两个测试文件，
7 行增加、8 行删除，保留安全断言目的，不增加 skip。补丁 SHA-256：
`c3b039fbfdfb62d009aadaafb243b5a1dfa2c06f3e37ccf0b242aa822f7b84f8`。
协调端已重建完全一致的补丁字节，32 项本地定向测试通过；macOS 完整
`npm run check` 也通过 252 项单元、4 项发布工具和 4 项平台检查，2 项文档工具测试
通过。生产源码不变。

第四项仍是宿主前提缺口：输出文件测试创建 `alias.txt` 符号链接时返回 `EPERM`。
Windows 应用补丁后的定向结果为 3 pass / 1 fail；尚未报告修正后候选的完整 check。
真实管道 DACL 检查通过，仅当前用户、SYSTEM、Administrators。SCM 创建服务权限
探测返回错误 5，因此真实 Windows Service 生命周期尚未验收。这些情况不能改记为
新增 skip 或验收通过，也不得通过扩大 ACL 或静默启用系统功能来隐藏。

Windows 原目录仍在 `main / 90e4449`，两行 WIP 依赖声明及文件摘要保持不变；
原始 stash 对象为 `fa72a20fd26be9db1e4857bc228fd138163efc28`。补丁最初只在
验收 worktree 中准备，Windows 未提交或推送。下一步是在干净 worktree 中获取协调端
的新提交，全量复验，并将符号链接及服务权限明确保留为待完成条件。

## 恢复结果

- 主 Profile 的原配置已恢复，包括 steer、默认无限并发和原生 Reviewer 原设置。
- 通过 `/attach` 恢复 QQ 私聊原 Thread Binding；保留已有历史和群聊绑定。
- 第二个测试 Profile 已停用，其数据、认证和独占 Channel Account 归属保留，后续
  可显式重新启用。
- 已确认配置版本：
  `fe6f3a0ed081b31d3090582c568d38555830e8dcb86b43982eebaefa7e244c47`。
- Supervisor live；主 Profile、QQ 和 WhatsApp Adapter ready；次 Profile stopped。
  没有活动测试工作、待审批请求或待投递 Outbox 记录。
- 最初真实验收期间没有数据库迁移、Profile purge、Archive 删除、tag、提交或发布；
  后续候选提交用于跨设备同步，不是版本发布。
