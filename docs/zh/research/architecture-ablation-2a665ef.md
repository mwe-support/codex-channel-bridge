---
title: 2a665ef 架构消融审计
---

# 2a665ef 架构消融审计

审计日期：2026-09-05。结论：保留现有进程隔离与持久化架构，优先减少重复状态与类型声明。当前证据支持小范围整理，不支持整体重写、合并全部包或删除可靠性层。

本报告记录最初的审计和待讨论提案。审计阶段，所有变体只在隔离的临时源码快照运行；主工作区的运行时代码、AGENTS.md、服务、凭据和运行数据均未修改，新增文件仅为本报告及其英文版本。此后用户授权了 A4、规则修订、按能力判断 Codex 兼容性及真实 QQ 验收。最新进度见[功能需求](../feature-requirements.md)的 FR-003/011/012 和[验收记录](../acceptance/capability-and-admission-20260905.md)；以下固定基准发现及当时的待讨论提案仍保留为历史审计证据。

## 基准与覆盖范围

- 指定基准：`2a665ef0029577e4c09036501deca775cc65b6a2`，版本 `0.2.0-rc.1`。
- 工作区实际 HEAD：`90e4449f3f4bf84015758be5c97241368acee070`；与基准仅差三个网站文件、20 行新增内容。源代码和 AGENTS.md 相同。
- 盘点了 12 个运行时包、76 个生产 TypeScript 文件、20,096 行。统计排除测试、contract 文件、声明文件和构建产物；不包含网站代码。重点追踪入站归档、访问和准入、Turn 关联、审批控制者查找、终态投递、存储 RPC、检索及监督关系；不是所有平台或安全场景的穷尽审查。
- `profile-store` 5,804 行、`profile-worker` 4,868 行、`control-plane` 2,893 行，合计约占生产 TS 的 67.5%。体积是定位线索，不是删除理由。
- 使用 `git archive` 导出固定快照。第三方依赖复用本机安装，内部 workspace 依赖重新链接到临时快照，避免测试误用主工作区构建产物。
- 本机 Node.js `22.23.1`、npm `10.9.8`。基线构建成功；250 个单元测试、4 个发布工具测试、4 个平台静态契约测试通过。平台静态检查不等于 Windows/Linux/Docker 现场验收。
- 本次没有运行真实 QQ/WhatsApp 消息测试、宿主 Codex 协议契约或远端生命周期测试，也没有发布、提交或部署变体。

## 优先处理的发现

### P1：重复活动状态漏同步，影响队列晋升后的审批与账户排空

位置：`packages/profile-worker/src/channel-ingress-controller.ts:139-148`、`:166-185`；消费者为 `profile-worker.ts:743-759` 和 `:1472-1481`。

`AdmissionController.release()` 已把候选项记为活动工作，但 `ChannelIngressController.release()` 只从 `#queued` 取出消息，没有加入 `#active`。随后 `markTurnStarted()` 写入第三张 `#turnTargets` 表；审批控制者查找却需要再次从 `#active` 取消息。

最小复现：第一条消息执行中，第二条进入 queue；第一条完成后第二条晋升并取得 Turn ID。实际结果为整体 `active = 1`，账户 `active = 0`，`controllerForTurn()` 返回 `undefined`。因此排空前置检查可能漏掉该账户的活动工作，审批请求无法获得其 Channel 控制者。这是合成控制器场景的实测结果；没有声称真实账号已发生事故。

实验 A4 将活动工作的消息和 Turn target 放在同一记录，移除 `#turnTargets`，并在晋升入口登记活动消息。Ingress 内独立 Map 从 3 张变为 2 张，净增 1 行。原有 250 个单元测试及新增队列断言通过。减少需要同步的状态比追求负行数更有价值；不应为此把 Codex Turn 生命周期搬进 Bridge。

### P2：Outbox 全批次串行等待，破坏同 Profile 内的通道独立投递

位置：`packages/profile-worker/src/delivery-outbox.ts:93-105`、`:72-90`。

一个 sweep 领取最多默认 8 条记录，再逐条 `await #deliverOne()`。只要首条 QQ 发送未返回，同批次 WhatsApp 发送就尚未启动。新增探针用一个可人工释放的 Promise 模拟 QQ 等待，在释放前只观察到 QQ 调用；独立 WhatsApp 调用的断言失败。既有测试仍全部通过。

这是 Bridge 的投递调度问题，不是证据表明必须拆分适配器进程。后续候选方案应让不同 Channel Account 的发送独立推进，同时保留同一 Logical Result 的分段顺序、数据库租约、重试和回执校验。简单地把整个批次改成 `Promise.all` 还不能证明批次间公平性、同账户顺序或停止边界，因此本轮未把它当成已验证修复。

### 设计取舍：严格全 Profile FIFO 存在队首阻塞

位置：`packages/profile-worker/src/admission-controller.ts:130-151`。

在显式并发上限 2、queue 模式下：A/B 活动，A2/C 排队；B 完成后，队首 A2 仍被 A 阻塞，代码直接 `break`，C 也不能开始，虽然已经有空槽。复现通过，确认这一行为存在。

这符合严格 FIFO，本报告不把它误报为默认无限并发失效。需要讨论的是：有限上限下，更看重全局入队顺序，还是允许跳过暂不可执行项以改善独立会话的等待时间。两种目标应明确择一，不宜同时承诺。

## 已执行的消融实验

每个独立变体从同一基准恢复后构建，保持原有测试不变；A4 另加行为断言。最后合并 A1+A2+A4 检查交互，再恢复快照源码并重新构建。行数按源码物理行统计，包含注释，不包含测试或本报告。

| 变体 | 移除或调整 | 行数变化 | 验证结果 | 结论 |
| --- | --- | ---: | --- | --- |
| A2 | 用存储方法签名推导 RPC 参数/结果类型，保留显式方法集合和运行时分派 | −29 | 构建成功，250/250 单测 | 可整理重复声明 |
| A1 | 删除无代码消费者的 `BridgeAction` 联合类型及其导出，保留被使用的 `AuthorizedParticipantContext` | −28 | 构建成功，250/250 单测 | 可删除死类型；无运行时性能收益 |
| A4 | 合并活动消息与 Turn target 的记录，补齐队列晋升登记 | +1 | 250/250 单测，新增队列断言通过 | 推荐优先作为修正候选 |
| A3 | 去除 fuzzy 计算及辅助函数，保留其他信号和查询边界 | −44 | 构建成功，249/250 单测；检索质量回退 | 属于功能取舍，不能直接删除 |
| A1+A2+A4 | 组合验证 | −56 | 250/250 单测，新增队列断言通过 | 可以进入单独的实现审查；尚未上线验收 |

`shrink:` 存储 RPC 类型可由原方法推导，避免同一签名在实现和协议中手工重复维护。位置：`packages/profile-store/src/async-profile-store.ts:51-123`。

`delete:` 删除没有仓库代码消费者的 `BridgeAction`，保留实际承担审批上下文的接口。位置：`packages/core/src/bridge-action.ts:1-27`、`packages/core/src/index.ts:29`。

安全删除候选合计净减 57 行、0 个依赖。不能将 A3 的 44 行加入无损精简收益；A4 是状态结构改进而非净删代码。A2 使用 TypeScript 自带的 `Parameters` / `ReturnType`，未引入生成器或动态任意方法调用；`close` 在传输中返回 `null` 的现有约定保持不变。[TypeScript 官方说明](https://www.typescriptlang.org/docs/handbook/utility-types.html#parameterstype)

## 检索实验：速度收益伴随可观察的召回损失

使用临时 SQLite 数据库、合成文本、每查询 3 次预热和 21 次计时。四个有明确目标的查询分别覆盖英文精确匹配、近期拼写错误、中文子串、超出近期候选窗口的旧消息拼写错误；另设一个无匹配查询。每个正例只有一条目标记录，Recall@5 是该目标是否进入前五。

先测试 2,003 条记录：目标消息恰在最近两条，删除 fuzzy 后，近期错拼仍因 recency 进入前五，但排名从第 1 降到第 2。为排除“新近程度恰巧命中”的混淆，再追加 100 条无关记录，使用相同的 2,103 条记录比较两种实现。

| 查询 | 基线中位耗时 ms | A3 中位耗时 ms | 基线 / A3 Recall@5 |
| --- | ---: | ---: | --- |
| 英文精确匹配 | 7.727 | 3.182 | 1 / 1 |
| 近期拼写错误 | 7.455 | 2.978 | 1 / 0 |
| 中文子串 | 7.665 | 2.987 | 1 / 1 |
| 旧消息拼写错误 | 7.966 | 3.026 | 0 / 0 |
| 无匹配 | 7.159 | 2.931 | 不适用；两者仍返回 5 条 |

在该小型合成集合里，四个正例的平均 Recall@5 从 0.75 降至 0.50。数字不是实际业务查询质量，也不是端到端回复延迟；未做多机器、冷缓存或多进程随机顺序测量，不据此预测生产加速比例。

基线也暴露两个已有上限：fuzzy 只扫描最近 1,000 个候选，旧拼写错误目标不能被找到；recency 无条件参与结果集合，无匹配时仍可能给出无关记录。源码位置：`packages/profile-store/src/hybrid-retrieval.ts:9`、`:66-72`、`:106-119`。应先定义“未命中”和可接受的历史覆盖，而不是为满足“六路”字面要求继续加算法。保留中文子串场景；SQLite FTS5 本身提供 BM25，无需另造词法评分器。[SQLite FTS5 官方说明](https://www.sqlite.org/fts5.html#the_bm25_function)

## AGENTS.md：待讨论的调整，不自动执行

| 规则位置 | 判断与证据 | 建议讨论的修改 |
| --- | --- | --- |
| 425-429：固定六路检索 | 过度规定实现，但 fuzzy 已有可测功能价值 | 将算法清单移入可修订 ADR；AGENTS 保留 Profile 隔离、无内容外发、事件循环边界和检索质量门槛。批准门槛前保留现有算法 |
| 334-339：固定优先级、跨 Profile round-robin、适配器内重试 | 未发现跨 Profile 工作调度队列；实际是独立 Worker。Outbox 又承担持久重试。文字与实现分工不清，且同 Profile 投递独立性已复现失败 | 明确 Worker 内控制响应的服务目标、跨账户不阻塞的可执行验收；适配器解释 provider 限制，Outbox 持久化下次投递时刻。避免为了字面 round-robin 增加中央调度器 |
| 320-331：独立会话与一个 FIFO | 显式有限上限下存在公平性和严格 FIFO 的取舍；不是逻辑上必然矛盾 | 若保留严格 FIFO，写明队首阻塞；若允许跳过忙 Thread，修改 ADR 0052，并保留同 Thread 顺序、总容量、TTL 和停机不积压 |
| 517-531：每个开发阶段真实 QQ 验收 | 对部署行为必要；未区分离线研究变体和候选实现 | 明确隔离快照、合成数据、无服务接入的消融属于研究。进入实际实现/集成阶段的 QQ 路径变化仍完成真实验收，不用单测替代 |
| 17-31：仓库 cutover 初始化要求 | 条件性的历史约束，不是当前有 origin 的违规证据 | 保留独立历史和许可证边界，已完成的 bootstrap 细则改为历史文档引用 |
| 558-568 与相关架构文档 | AGENTS 已允许受限 Dashboard；ADR 0053 已明确覆盖 ADR 0041 的延期决定。因此不是 AGENTS 自相矛盾 | 修正文档漂移：`docs/architecture.md:24-25` 仍声称没有 HTTP/web 管理服务，ADR 0041 可加被覆盖标记 |

可供逐条讨论的规则草案：

> 在固定提交的隔离源码快照上，可以使用合成数据进行消融研究。每次只改变一个因素，保留基线、行为测试、质量指标和代价；研究结果不得宣称已满足部署或真实通道验收。实际集成仍遵守相应平台和通道验收要求。

> 检索应满足经批准的相关性、历史覆盖、无匹配结果和资源预算要求。具体信号与排序策略在 ADR 中记录，可根据消融证据调整；Profile 隔离、无外部内容披露和同步存储不阻塞 Channel 事件循环保持强制。

> 各 Profile 独立执行，不要求中央逐工作轮询。不同 Channel Account 的 provider 等待不得串行阻塞其他账户的已就绪投递；保持同一 Logical Result 的分段顺序。适配器提供 provider 语义与等待提示，Outbox 保持持久重试和回执关联。

用户已选择“讨论按可验证结果约束设计”。这确认了讨论方向，没有批准具体规则变更。仍需确定检索质量及资源门槛、投递公平性的准确边界，以及有限并发下是否维持严格全 Profile FIFO。这些草案没有修改生效中的规则。

## 保留的边界与下一步实验

保留一个 Supervisor、每 Profile 独立 Worker/App Server、stdio、异步 SQLite Worker、持久关联/Outbox、审批原请求关联、控制面授权、迁移/备份/审计边界。它们分别承接进程生命周期、信任、恢复或阻塞隔离，不因“只有一个实现”而自动冗余。事务历史迁移也不能因为体积大就删除。

没有证据支持移除七个现有生产第三方依赖，或把 12 个包合成一个巨型模块。`TurnCoordinator` 的原生协议调用、`ConversationTurnCoordinator` 的路由与持久提交、`CodexEventRouter` 的通知关联承担不同边界，暂不合并。

推荐顺序：先将 A4 的失败场景纳入正式回归，再审查 A1/A2 的整理；单独为 Outbox 做跨账户发送阻塞、整批被一个账户占满、分段顺序、重启和排空实验；检索在具有代表性的中文/英文、旧记录、错拼、精确值和无匹配标注集上做逐信号消融。通过现有 250 个测试只是必要证据，不能当成全部语义等价证明。

下一轮每项实验事先写明：保留的不变量、单一删除因素、反例、通过阈值与回滚条件。任一隔离/审批/去重/恢复回归即拒绝候选；性能候选同时满足质量门槛后才可推进。不要把减少文件数或行数作为唯一目标。

## 本地证据与复现

本次原始日志、JSON、补丁和探针保存在 `/private/tmp/bridge-audit-evidence-2a665ef/`；源码快照在 `/private/tmp/bridge-audit-2a665ef/`。这些是本机临时审计产物，未提交为发布证据；目录被系统清理后需重建。

- `ablation-results.json`：A1/A2/A3 单因素结果；对应 `.patch` 和 `*-unit.log` 保留精确变化及失败测试。
- `behavior-probes.test.mjs`、`baseline-behavior.log`：队列同步与跨账户投递断言在基线失败；严格 FIFO 队首阻塞复现通过。
- `A4-co-located-active-state.patch`、`A4-result.json`、`A4-probe.log`：状态整理变体及队列断言通过证据。
- `combined-result.json`、`combined-unit.log`、`combined-probe.log`：A1+A2+A4 交互验证。
- `retrieval-benchmark.mjs`、`baseline-retrieval*.json`、`A3-retrieval*.json`：两种语料布局的完整计时、召回与匹配信号。
- `run-ablation.py`、`run-state-ablation.py`：本机快照的变体运行脚本，内含固定路径；只能指向隔离快照，不用于生产工作区。

恢复后的基线执行 `node --test /private/tmp/bridge-audit-evidence-2a665ef/behavior-probes.test.mjs` 预期退出 1，含两个失败断言；这正是本报告发现的反例，不应隐藏或修改断言使它“全绿”。检索实验通过 `AUDIT_NOISE_AFTER=100 node /private/tmp/bridge-audit-evidence-2a665ef/retrieval-benchmark.mjs` 重跑带额外噪声的基准。
