---
title: 功能需求清单
---

# 功能需求清单

这是新增用户需求的工作清单，不是已发布版本的功能列表。从 2026-09-04 开始维护。
既有交付与平台验收门槛仍见[发布状态](release-status.md)和
[限制与路线图](limits-and-roadmap.md)，本清单不会重置这些进度。

## 更新契约

1. 追加前先检查已有条目。使用稳定的 `FR-NNN` 编号；保留延期及完成的条目，
   不复用编号。
2. 未决想法记为 `discussing`（待讨论）。用户认可可实施范围后才改为
   `accepted`（已接受）。编写运行时代码前记录归属、边界、验收条件与待决事项。
3. 范围、实现、验收或卡点变化时，同步更新中英文，包括尚未完成的开发过程。
   每个条目记录更新日期、当前证据和下一步。卡点描述缺少的决定或证据，
   不把推测的故障原因写成结论。
4. 实现中使用 `in-progress`；代码就绪但必要测试未完成时使用
   `awaiting-acceptance`。依赖阻止推进时使用 `blocked`；明确延期使用
   `deferred`，并保留原因。
5. 条目验收条件与仓库适用门槛均通过后才能使用 `done`。链接代码、测试及不含
   内容的真实验收证据。单独记录实际不可变 release tag；`Next / unassigned`
   不代表发布承诺。新证据推翻完成结论时，应重新调整状态。

Markdown 条目是需求进度的事实来源；架构以 ADR 为准，已发布行为以对应 tag 的
文档为准。不增加另一套 Issue 数据库或需求管理服务。

## 索引

| 编号 | 需求 | 状态 | 发布版本 |
| --- | --- | --- | --- |
| FR-001 | WhatsApp 等待提示与完整回复 | awaiting-acceptance（待验收） | `0.2.0-rc.1` |
| FR-002 | Channel Conversation 在宿主机 Codex App 中可见 | discussing（待讨论） | unassigned |
| FR-003 | 不同会话默认不受并发上限限制 | awaiting-acceptance（待验收） | `0.2.0-rc.1` |
| FR-004 | Dashboard 配置、Profile 日志与重启控制 | accepted（已接受） | Next / unassigned |
| FR-005 | Dashboard 会话管理 | accepted（已接受） | Next / unassigned |
| FR-006 | QQ 私聊原生流式回复 | awaiting-acceptance（待验收） | `0.2.0-rc.1` |
| FR-007 | 无参数命令查询当前模型与思考强度 | done（已完成） | `0.2.0-rc.1` |
| FR-008 | Channel Account 管理员与全局设置命令 | deferred（延期） | unassigned |
| FR-009 | QQ 与 WhatsApp 原生审批可靠性 | done（已完成） | `0.2.0-rc.1` |
| FR-010 | 自动输出文件投递到原会话 | awaiting-acceptance（待验收） | `0.2.0-rc.1` |
| FR-011 | 各 Channel Account 独立投递 | done（已完成） | Next / unassigned |
| FR-012 | 按实际能力判断 Codex 兼容性 | done（已完成） | Next / unassigned |

## FR-011 — 各 Channel Account 独立投递

- 更新：2026-09-05。状态：`done`；版本：Next / unassigned。
- 用户授权落实消融结论、修订 AGENTS.md，并使用两个凭据通过真实 QQ 客户端进行
  多 Profile 验收。归属 Bridge 调度：复用 Outbox，按账户独立领取/发送，保留租约、
  回执与 Logical Result 分段顺序，不引入中央调度器或新 Schema。
- 验收：阻塞或占满批次的账户不能阻止另一账户当前及后续投递；按账户回收过期租约
  不影响其他账户；既有重试/重启/排空契约通过。真实 QQ 覆盖两个 Profile、重叠执行、
  中断隔离、队列晋升，以及平台与客户端最终投递。
- 准入修正继续归 FR-003：同 Thread FIFO、最早可执行项扫描、总容量/TTL 与活动状态
  一致性。检索信号保留，等待单独的实测取舍决策。
- 已实现并通过 macOS/原生 Linux 的 252 项单元测试、发布/平台检查及原生契约，
  Docker 原生契约通过。16 条带标记的真实 QQ 输入均进入终态，最终投递 accepted；
  队首跳过、晋升审批、跨 Profile 审批拒绝、中断隔离均实测通过。主配置/原绑定已恢复，
  次 Profile 停用并保留数据。Windows 本轮未重跑，不作其验收声明；尚未提交或发布。
- [准确证据与边界](acceptance/capability-and-admission-20260905.md)。

## FR-012 — 按实际能力判断 Codex 兼容性

- 更新：2026-09-05。状态：`done`；版本：Next / unassigned。
- 用户明确要求不固定 Codex CLI 版本，以适应宿主频繁更新。Codex 仍由管理员提供，
  Bridge 不修改其安装。
- 取消版本下限与宿主测试中的固定版本/摘要断言。探测生成的方法和真实初始化/模型
  发现；必要能力缺失只使对应 Profile 失败关闭，可选能力缺失只禁用对应功能。
  识别可选方法晋升到稳定接口；未验收组合仍标记 unverified。
- Docker 显式接收构建版本，不预设支持版本；保留历史验收快照，不改写旧证据。
- 验收：旧/新/预发布版本号不阻止能力完整的 Schema；缺少必要方法失败关闭；
  可选方法缺失/晋升行为正确；用当前宿主可执行文件运行原生契约和真实 QQ 多 Profile
  回归，不安装或升级宿主 Codex。
- 已取消版本门槛和固定版本/摘要契约断言，保留能力失败关闭与历史验证标记。
  macOS、原生 Linux、Linux Docker 均使用实际 Codex 0.153.4 通过原生契约；
  真实 QQ 多 Profile 回归通过。其他版本的标签行为由合成 Schema 回归验证，
  不宣称已实测所有 CLI 版本。Windows 本轮未重跑；未修改宿主安装、提交或发布。
- [准确证据与边界](acceptance/capability-and-admission-20260905.md)。


## FR-009 — QQ 与 WhatsApp 原生审批可靠性

- 更新：2026-09-05。状态：`done`；版本：`0.2.0-rc.1`。
- 用户同意先验证审批、再实施文件投递，并授权使用本机 QQ 与 WhatsApp 客户端实测。
- 复用原生命令/文件审批请求、原进程请求响应、参与者绑定和既有持久 Outbox；
  不改变 Reviewer 策略。
- 验收：QQ 与 WhatsApp 真实请求/决定往返；拒绝、重复/过期 TOKEN、错误参与者/
  会话、连接代际丢失和投递失败回归。分别记录平台回执、客户端可见与原生执行，
  不承诺越过 QQ 回复权限投递。
- 已实现原生请求/Turn 取消清理、代际关闭时写失败的竞态保护，以及可见的决定/
  拒绝反馈。QQ 与 WhatsApp 真实私聊审批、决定、重复 TOKEN、取消、超时检查
  通过，跨渠道 TOKEN 被拒绝。原配置和 Thread 绑定已恢复；241 项单元、4 项
  发布工具、4 项平台测试、宿主原生协议及双语文档构建通过。
- [验收记录与准确范围](acceptance/channel-approval-reliability.md)。未支持的请求
  类型继续 fail-closed；不代表真实群聊或文件修改审批通过，也不承诺绕过平台投递限制。

## FR-010 — 自动输出文件投递

- 更新：2026-09-05。状态：`awaiting-acceptance`；版本：`0.2.0-rc.1`。
- 已接受：用户选择自动上传模型提及的文件，不要求 `/file` 命令。首版识别已完成
  最终回复中的本地 Markdown 文件链接，不解析任意说明文字、代码示例或扫描工作区。
  使用 Profile 显式启用开关，避免改变现有部署的文件外发行为。
- Bridge 传输校验文件范围/类型/大小，保存不可变字节用于持久重试，复用 Outbox
  与提供商 SDK 上传/发送接口，区分上传、消息接受与收件客户端下载。
- 不公开文件服务器、不读取任意宿主文件、不复制 Codex 历史，不为此引入渠道管理员。
- 验收：QQ 与 WhatsApp 实际下载无害测试文件并核对摘要；隔离、非法路径/符号
  链接、大小限制、上传/发送失败及重启重试检查。FR-009 审批门槛通过后实施。
- macOS 上 QQ 与 WhatsApp 私聊/群聊真实附件投递均通过：客户端下载与原文件及
  Outbox SHA-256 一致。两个私聊的不存在/越界链接均显示拒绝提示，未投递文件。
- 已实现：有界工作区链接快照、共享媒体额度、schema 11 附件 Outbox、QQ 上传/发送与
  WhatsApp document/account 转发。macOS 上 250 项单元、4 项发布工具、4 项平台检查、
  原生 Codex 0.149.1 协议契约与双语文档构建通过。
- 部署门槛已通过：用户明确授权后完成 Profile drain、管理员快照及摘要校验、迁移源
  摘要匹配、显式 schema 10→11 迁移、backup finish 与确认的配置应用。macOS 测试
  Profile 已启用自动附件。上传/发送失败与持久重启重试由确定性测试覆盖，不冒充
  真实平台故障验收。
- 剩余：原生 Linux、Linux Docker、Windows 附件链路验收及适用的发布/回滚门槛。
  本功能未提交或发布。参见[验收证据](acceptance/automatic-output-files.md)与
  [使用说明及准确限制](output-files.md)。

## FR-008 — Channel Account 管理员与全局设置命令

- 更新：2026-09-05。状态：`deferred`；版本：unassigned。未修改运行时权限或配置。
- 为避免持久继承、覆盖与批量失败处理的复杂度而延期；保留逐 Thread 模型/思考
  强度命令。下方提案不代表已授权实施。
- 用户提议：每个 channel 通过配置指定一名管理员；管理员在私聊使用
  `/model MODEL_ID --global` 等 slash 命令调整渠道全局设置。不带参数标记的命令维持原范围。
- 建议术语：Channel Account Administrator 对应某个 Bot/登录账号下由提供商认证的
  一个稳定参与者身份，不是私聊 Thread ID、昵称、QQ 展示号码或跨提供商身份。
  私聊是管理入口。由宿主管理员通过显式配置应用指定/移除角色；未配置则无人有全局权限。
- 建议边界：`--global` 只覆盖该 Channel Account 的授权绑定，不涉及同 Profile 的
  其他 QQ/WhatsApp 账号或整个 Profile；保留普通访问检查。该角色不获得宿主管理、
  账号撤销、归档删除、Codex 权限或代替他人审批的能力。
- 首期显式支持模型/思考强度命令，不把 `--global` 通用化到 `/approve`、`/stop`、
  `/new` 或任意 slash 命令。逐 Thread 使用原生设置接口；不写可能影响其他账号的
  Profile 级 Codex 配置。
- 待定：全局是一次批量修改现有绑定，还是也持久设置未来 Thread 的默认值？后者需要
  显式调整 ADR 0023 与 AGENTS.md 的归属/持久化契约，不能暗中引入 Bridge 模型缓存。
  还需确定是否覆盖已有 Thread 的单独选择，以及后续是否允许局部覆盖。
- 实施前确定下一 Turn 生效时机、有界批量确认、部分失败及原生回查、模型与强度兼容，
  以及共享 Thread 去重。某个 Thread 若同时绑定选定 Channel Account 之外的会话，
  不得静默修改；不承诺跨 Thread 原子更新。
- 下一步：与用户确认范围/默认值语义，再更新术语和相关角色/设置契约后实施。
  现有原生方法与真实隔离证据见 [FR-007 验收](acceptance/model-reasoning-queries.md)。

## FR-007 — 查询当前模型与思考强度

- 更新：2026-09-04。状态：`done`；版本：`0.2.0-rc.1`。
- 无参数 `/model`、`/reasoning` 查询当前绑定 Codex Thread 的模型和思考强度，
  原有带参数切换命令保留。
- 数值由 Codex 管理；复用原生 Thread 设置读取，不传覆盖参数、不启动 Turn、
  不建立 Bridge 设置缓存。空思考强度明确显示为 Codex 默认/未指定，不按模型目录猜测。
- 授权私聊与群聊（包括共享群聊）可查询；现有共享群聊的修改权限约束不变。
  未绑定会话明确提示没有 Thread，不自动新建。
- 验收：解析、原生只读调用、共享群聊权限、未绑定/空强度及切换回归；
  在 macOS 部署后通过真实 QQ 验证查询与带参数命令，再标记完成。
- 已复用现有解析器和 `readThreadSettings` 实现，不增加配置或持久化。
  回归覆盖缺少实验性更新能力时查询、空强度、未绑定、共享群聊禁止修改，
  以及原有带参数切换。部署到 macOS 的候选版本已通过真实 QQ 私聊/群聊查询及切换回查。
- 补充验收：记录两个独立绑定会话的设置，只修改其中一个，再回查两个会话并恢复。
  验证模型和思考强度修改不传播到同一 Profile 的另一个 Thread。
- 同一 Profile 下两个 QQ 会话的隔离通过；私聊设置已恢复，群聊保持不变，查询未创建
  模型 Turn。真实群聊还修复了开头不透明提及标记的归一化问题。
  [验收证据](acceptance/model-reasoning-queries.md)记录 238 项单测、原生协议检查和
  精确真实测试范围。其他功能门槛仍未关闭。

## FR-001 — WhatsApp 等待提示与完整回复

- 更新：2026-09-04。状态：`awaiting-acceptance`；版本：`0.2.0-rc.1`。
- 调整后的需求：Codex 思考或调用工具时显示等待提示，Turn 结束后再发送完整文本。
  本需求取代先前模拟流式方案及尚未发布的 `streamingPreview` 配置。
- 此回退仅针对 WhatsApp 模拟文本流式，不取消 QQ 私聊原生流式（FR-006）。
  QQ 群聊与 WhatsApp 发送完整文本；等待提示取决于各平台实际 API 能力。
- 归属：Codex 拥有 Turn 生命周期和输出；Bridge 将已接受的 Channel 工作映射到
  Baileys 原生聊天状态；具体视觉效果由 WhatsApp 决定。不展示推理/工具内容，
  不虚构细分进度阶段。
- 契约：固定 Baileys `7.0.0-rc14` 实现
  `sendPresenceUpdate("composing" | "paused", jid)`，参见
  [上游状态文档](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/socket/presence-receipts.md)
  和 [Adapter 行为](whatsapp-adapter.md#等待提示)。

### 范围与验收

- 已接受并开始执行的 WhatsApp 工作自动显示原生输入提示，在文本生成之前启动，
  每 5 秒刷新。不增加设置项，不人为延迟回复；QQ 保持不变。
- 完成、失败、中断或断开后停止刷新。同一群聊按参与者区分的并发 Turn
  共享提示，最后一个结束后收起。拒绝、旁听及尚未开始的队列输入不显示提示。
- 尽力而为，不发送或编辑预览文本，不写入 Durable Outbox；
  状态发送失败不能阻止 Codex 或既有完整结果投递。
  客户端决定显示气泡或“正在输入”文字，不承诺自定义气泡或区分思考与工具阶段。
- 验证立即提示、无文本增量时刷新、并发对话/Turn、旧连接清理、拒绝/发送卡住，
  以及仅完整回复的投递行为。本机 macOS 真实私聊/群聊等待与清理验收、
  共享链路真实 QQ 回归通过后才能提交。
- 实现已删除预览缓冲、文本增量回调/能力探测和预览配置，改为原生状态生命周期。
- 历史[流式预览验收](acceptance/macos-whatsapp-stream-preview.md)只适用于已被取代的实现，
  不作为调整后需求的验收证据。
- 已验证：`npm test` 通过 225 项单元、4 项发布工具、4 项平台契约测试；
  `npm run docs:build` 中英文构建通过；`git diff --check` 通过。
  宿主 `npm run test:contract` 通过，Codex 0.149.1，Schema SHA-256 为
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`。
- 首次部署到本机原生 macOS：复用已关联账号，不再使用预览环境覆盖，凭证/策略不变；
  Supervisor 为 live，Profile 和 Adapter 为 ready。配置版本为
  `2566334a2c74896c3da5d201e701aa305068245a42f42f1eea0cee0e928b67cf`。
  四个生产源码文件（core channel-adapter、profile-worker、
  whatsapp-adapter、whatsapp-channel-account）按上述顺序将相对路径、换行、文件
  字节聚合后，SHA-256 为
  `e921a108d4faf1d00e70b2000d9ad1e54a81639ee9af0f5b0b3cfbaa3c2f83d9`。
  该值标识功能源码，不代表完整部署或发布产物。
- 后续部署包含 FR-003 的无限制准入，当前配置版本见下方对应条目。
  FR-003 部署之前，等待提示构建的五次真实 Turn（四次私聊、一次群聊）均完成，最终投递 accepted 且
  都是首次尝试；群聊 Turn 耗时 544,788 毫秒。这些回执不能证明提示可见或已收起。
- 下一步：观察用户真实 WhatsApp 私聊/群聊的等待提示与完整回复，再完成 QQ 门槛。
  服务就绪不等于视觉验收通过；尚未提交或发布。

## FR-002 — Channel Conversation 在宿主机 Codex App 中可见

- 更新：2026-09-04。
- 需求：在部署主机的 Codex App 项目视图中区分不同私聊/群聊。
  Hermes Dispatch 的 `session_key` 命名只作为历史动机，不作为实现依赖。
- 归属：Bridge Conversation Key 与 Thread Binding 确定路由；Codex 拥有
  Thread 元数据、历史、项目展示和桌面状态。
- 证据：原生 `thread/name/set` 可设置 Thread 标题；`thread/list` 支持 `cwd`
  与来源过滤。官方文档说明默认来源为 `cli`、`vscode`，可显式选择 `appServer`。
  这些协议事实不能证明桌面端实际采用的查询行为。
  见 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。
- 本地边界：[TurnCoordinator](https://github.com/mwe-support/codex-channel-bridge/blob/4a655d34b038d33b3b53eb8af099ca0b8c03f9c6/packages/profile-worker/src/turn-coordinator.ts)
  使用 Profile Workspace 创建 Thread；
  [App Server 启动代码](https://github.com/mwe-support/codex-channel-bridge/blob/4a655d34b038d33b3b53eb8af099ca0b8c03f9c6/packages/codex-app-server/src/app-server-process.ts)
  注入 Profile 独立的 `CODEX_HOME`。相同 Workspace 路径或修改标题本身，
  都不能证明桌面端可以发现这些 Thread。

### 推荐的最小范围——尚未确认

- 一个 Profile Workspace 仍对应一个项目范围，在其下显示不同绑定 Thread。
  保留群聊按 Conversation 或 Participant 的既有 Thread Scope。
  不为每个私聊/群聊创建新 Workspace。
- 使用原生 Thread 命名，展示可读的 Channel/类型标签与不暴露身份的内部路由短码，
  例如 `[WhatsApp][group] Support · c-7f92`。这是虚构展示示例，不是新路由键。
  标题不包含原始 Provider ID；展示名称不决定身份或权限。
- 先验证发现与查看。桌面端写入/接管另行决策，不能让两个客户端同时控制一个 Thread。
- 保持 Profile Codex home 独立。不复制 Rollout、不修改 Codex 私有数据库、
  不伪造来源身份，也不把各 Profile 合并到桌面端默认 home 来强行显示。

### 待决问题与验收门槛

1. 部署的桌面版本是否提供受支持的方式，查看指定 Profile 的 Codex home，
   并包含 App Server 来源的 Thread？此需求尚未验证出这样的路径。
2. 仅查看是否足够，还是需要桌面端接管进行中的工作并把控制权交回 Channel？
   推荐先做查看。
3. 使用不同私聊/群聊，实际验证桌面端发现、标题、项目归类、重启保留、
   跨 Profile 隔离与重名情况。仅 API 能列出 Thread 不算验收通过。

下一步：确认查看或控制权交接范围，并在部署的桌面端做原生能力验证，不改变生产
历史或 Profile 隔离。如果发现必须修改不受支持的存储才能显示，则保留为
blocked/deferred，在实现前解释该边界。

## FR-003 — 不同会话默认不受并发上限限制

- 更新：2026-09-05。状态：`awaiting-acceptance`；版本：`0.2.0-rc.1`。
- 后续修正，Next / unassigned：用户已授权审计 A4 的活动状态整理。
  队列晋升回归在修正前失败（账户活动计数为 0，预期为 1），将 Channel 上下文与
  Turn 目标合并存储、登记晋升工作后通过；同时覆盖控制者查找、参与者校验、
  排空期间保留关联与释放清理。A4 初始修正保持 FIFO 和准入上限不变；随后按 ADR 0052 的 Next 修订允许跨 Thread 跳过忙项。此修正不属于既有
  不可变发布；`npm run check` 通过 250 项单元、4 项发布工具和 4 项平台静态测试，
  `npm run docs:test` 通过 2 项工具测试，`git diff --check` 通过。
  后续真实 QQ 晋升/审批、队首跳过与中断隔离已通过；主配置和原绑定恢复，其他 FR-003
  既有验收项保持原状态。见[本轮证据](acceptance/capability-and-admission-20260905.md)。
  本轮已部署候选代码，尚未提交或发布。
- 需求：群聊和私聊不能仅因为共享 Profile 就互相阻塞；Bridge 默认不限制并发 Turn 数。
- 归属：仅调整 Bridge 准入。Codex 拥有各 Thread/Turn；
  不为每个会话新增进程、Gateway、调度系统或复制历史。
- 范围：`admission.maximumActiveTurns: null` 表示无限制，并作为默认值。
  保留管理员显式设置整数上限，既有显式限制不会被悄悄丢弃；完全设置支持无限制。
- 保留同 Thread 原生 steer 或显式 queue 模式、权限/发起人校验、
  账号消息速率、有界队列和磁盘保护。不承诺无限宿主资源、取消模型/平台限制，
  或共享 Workspace 文件的并发修改不会冲突。
- 验收：不同绑定的群聊与私聊同时启动；停止/失败其中一个不影响另一个；
  同 Thread steer/queue 仍正确；显式上限仍生效；Worker/设置向导无隐藏单并发默认。
  真实 macOS WhatsApp 重叠任务与共享链路 QQ 回归通过后才能提交。
- 证据：运行配置版本 2566334a2c74896c3da5d201e701aa305068245a42f42f1eea0cee0e928b67cf
  使用 steer 和 maximumActiveTurns=1；真实私聊/群聊关联有两个不同 Thread ID 和绑定。
  只读内存准入复现中，上限 1 拒绝第二个 Thread，上限 2 则允许启动。
- 已实现可空无限制配置、Schema/Worker 默认值、完全设置选项和针对性回归。
  `npm test`：229 项单元、4 项发布工具、4 项平台契约测试通过；
  中英文文档构建、`git diff --check`、宿主 Codex 0.149.1 协议契约通过。
- 本机原生 macOS 部署已显式使用 `maximumActiveTurns: null`，配置版本为
  `cfb8aa81049fc290a4144d7624eb31317b0c8d0dfb5d1c5de18cd506cab949bc`。
  Supervisor、Profile 与 WhatsApp Adapter 为 live/ready；之前的任务完成后
  才执行有界重启。凭证/策略不变，本地 Dashboard 进程跨重启保留。
- 2026-09-04 本机真实并发已验证：私聊与群聊使用两个不同 Thread，
  重叠执行 23,085 毫秒并分别完成；两个最终 Outbox 记录均首次尝试 accepted。
  这证明并发执行，不证明提示可见或中断隔离。
- 下一步：独立中断、提示可见/收起与共享链路 QQ 验收。尚未提交或发布。

## FR-004 — Dashboard 配置、Profile 日志与重启控制

- 更新：2026-09-04。状态：`accepted`；版本：Next / unassigned。
- 需求：默认展示正在使用的可编辑配置、按 Profile 查看实时运行日志，
  明确修改的重启要求并提供对应操作；Hermes 仅作为 UX 调研参考，不引入其运行时。
- 归属：Dashboard 展示经过认证的本地控制平面；Supervisor 拥有配置版本与 Worker
  生命周期；服务管理器拥有 Supervisor 进程。Secret 值沿用现有无回显设置路径。
- 范围：展示实际配置路径与可编辑的非秘密 YAML，区分磁盘内容、当前生效配置及
  环境覆盖；提供校验/预览/确认/应用及过期编辑冲突保护，不静默保存或应用。
  展示配置的 secrets 文件位置及安全更新说明/状态，不显示 Secret 内容，
  不提供任意文件浏览器。
- 日志：按 Profile 筛选的有界、无内容运行事件流，包含时间、事件码、状态和错误。
  经 IPC 传递真实 Worker/Supervisor 事件，不能用 Dashboard 刷新事件冒充，
  不读取 Archive 正文、Codex 历史或让浏览器直读日志文件；
  日志持久化与轮转继续由平台负责。
- 重启：区分单 Profile 重启与 Supervisor 重启。确认前预览当前工作、有界排空影响
  和操作范围；Profile 重启不影响其他 Profile。只有验证了服务管理器能力才提供
  Supervisor 重启；前台部署明确展示不支持/手工操作说明，不做虚假的成功按钮。
- 已核对的现有缺口：Dashboard 只有 status/config-plan/apply 及自身的 100 条事件；
  Worker child 只转发健康状态，不转发普通 Turn/投递事件；
  父进程消费并丢弃 Worker stdout/stderr。配置计划只比较 Profile 设置，
  不比较 secrets 文件内容或 Supervisor 设置变化。因此仅重新应用相同 YAML，
  不能证明已编辑的 Secret 或运行级选项已经重新加载。
- 验收：过期编辑/保存冲突、无效配置保留旧状态、环境优先级、Secret 不泄露、
  Profile 实时日志筛选、明确的重启影响、其他 Profile 隔离、前台不支持状态。
  提交前完成实际网页与本机 macOS 运行验收。
- 下一步：纳入 [Hermes 调研](research/hermes-dashboard-operations.md)，补齐配置/重新
  加载语义，再沿现有控制平面接口实现。尚未交付 Dashboard 运行时改动。

## FR-005 — Dashboard 会话管理

- 更新：2026-09-04。状态：`accepted`；版本：Next / unassigned。
- 需求：将 Channel Conversation 管理纳入 Dashboard。
- 首次范围：按 Profile/Channel 筛选、区分私聊/群聊，展示绑定的 Codex Thread
  标识和正在运行/等待/已结束状态，并通过本地管理接口确认后使用原生接口中断
  选定的准确 Active Turn。
- 归属：Bridge 拥有 Conversation/Thread Binding 标识，Codex 拥有 Thread、
  Turn 和历史。这与 FR-002 的宿主 Codex App 可见性是不同需求；
  不建立平行会话历史库，不读取 Codex 私有文件。
- 实现前验证原生读取/中断 Schema 与管理员控制范围；精确关联
  Thread/Turn/连接 Generation，防止旧页面中断替代任务或其他会话。
- 新建 Thread、重命名、绑定/解绑、恢复、归档与历史正文查看作为可能的后续切片，
  不隐含批量删除或桌面控制权接管。其详细权限与确认流程仍为 discussing。
  Dashboard 操作不能绕过既有 Profile Workspace 边界。
- 验收：独立私聊/群聊列表与控制目标、跨 Profile 隔离、过期状态拒绝、
  并发下独立中断；不能把删除 Bridge 绑定解释为删除 Codex 历史。
- 下一步：与 FR-004 一起设计最小原生/控制平面投射与网页流程。
  已记录需求，尚未实现或发布。

## FR-006 — QQ 私聊原生流式回复

- 更新：2026-09-04。状态：`awaiting-acceptance`；版本：`0.2.0-rc.1`。
- 用户重申的投递契约：QQ 私聊使用腾讯原生 C2C 流式接口；QQ 群聊及 WhatsApp
  不做答案文本流式，保留完整结果回复。FR-001 的 WhatsApp 回退不覆盖此契约。
  此条目补录遗漏的需求，不是要求用户重新选择方案。
- 归属：Codex 拥有生成的答案文本和 Turn 完成状态；Bridge 将允许展示的答案事件
  投射到 QQ 原生流；腾讯拥有流身份、帧接收与客户端展示。不泄露原始推理/工具输出，
  不通过连续发送多条普通消息模拟流式。
- 证据：[QQ 平台调研](research/qq-long-running-delivery-limits.md)已区分 C2C
  流式接口与不支持流式的群聊。修复前 QQ Adapter 仅暴露离散 `sendText`；
  普通回复成功回执不等于流式验收。缺失链路属于实现缺口，不是私聊预期行为，
  也不是操作员配置错误。
- 验收：本机 macOS QQ 私聊在 Turn 完成前可见同一条原生消息持续更新，
  并获得 DONE 帧成功回执。持久化流身份/序号，与现有 Logical Result/Outbox
  协调终态投递，避免成功流式后再重复发送完整答案。
  验证短任务/长任务、过期、限流、中断、连接/进程丢失、不确定帧结果，以及不丢文本的
  完整结果回退。确认 QQ 群聊与 WhatsApp 仍为非流式完整回复，并发会话不串线、
  不相互阻塞。
- 工作区已实现：按 phase 筛选原生答案增量、仅 QQ C2C 发送流帧、schema-10 投递元数据、
  合并更新、持久 DONE 回执恢复、普通 Outbox 回退，以及超长 QQ 文本无损分段。
  见[测试证据](acceptance/qq-native-streaming.md)。
- 本机部署：快照校验并取得操作员确认后，显式 schema 9→10 迁移已完成；
  QQ、WhatsApp 均就绪，Dashboard 保留。首次真实测试发现剩余长度为零时错误停止续帧。
  回归测试与修复通过后，新一轮真实 QQ 接受 44 帧（含 DONE），终态前可见正文增长，
  最终复用同一流回执。短回复也已通过。标记完成或发布前，继续补齐证据中列出的边界验收。
