# Logical Result 与持久 Outbox

## 所有权与提交顺序

Codex 拥有 Thread、Turn、Item 和终态 Status。Bridge 只存储终态 Event 后恢复 Channel 投递所需的 Projection。一次 `commitCodexTurnResult` Operation 会在同一个 Immediate SQLite Transaction 中把关联的 Codex Input 转为终态，并创建 Logical Result 和所有初始 Outbox Segment。在该 Transaction 提交前绝不调用 Provider Send。恢复期的不确定结果通过 `commitCodexInputUncertainty` 使用相同模式，因此同一 Correlation 不会同时产生终态回复和不确定回复。

Identity `(Profile ID, Codex Thread ID, Codex Turn ID)` 只允许一个 Logical Result。稳定 Payload Digest 覆盖 Destination 与 Segment Content。重复提交相同终态结果时返回已有 Logical Result 和 Outbox Identity；同一 Turn 使用不同 Content 或 Destination 重放时以 `logical_result_conflict` 失败。

## Outbox 状态机

| State | 含义 |
| --- | --- |
| `pending` | 已提交，等待首次 Delivery Attempt。 |
| `leased` | 已由当前 Profile Delivery Sweep 独占认领。 |
| `retry_wait` | Delivery 被延期或结果不确定，等待持久化的 Retry Time。 |
| `accepted` | Provider 返回匹配的 Accepted Receipt。 |
| `rejected` | Provider 明确拒绝该 Segment，或同一 Logical Result 的更早 Segment 已被拒绝。 |

同一 Logical Result 的 Segment 按顺序 Lease。只有前面的所有 Segment 都处于 `accepted`，后续 Segment 才具备资格。明确拒绝还会把所有尚未发送的后续 Segment 标为 Rejected，以维持一个完整的终态 Channel Outcome，而不是发送残缺的尾部。

每个 Lease 都有随机 Token 和 Expiry。Settlement 必须提供当前 Token，因此旧 Worker 不能覆盖更新的 Attempt。过期 Lease 会回到 `retry_wait`，并把 Attempt Outcome 标为 `ambiguous`，因为 Crash 可能发生在 Provider 接受 Send 之前或之后。

## Profile-local Delivery Sweep

每个 Profile 拥有一个不会重叠运行的 `DeliveryOutbox` Sweep。Baseline 每次最多认领 8 条记录，Lease 为 30 秒，并在 500 毫秒后安排下一次 Sweep。只有持久记录与当前配置中的 Provider、Channel Account 和 Channel Account Epoch 全部匹配时才会解析出 Adapter。缺失或过期的 Adapter Binding 记为 `deferred`，不能表示成 Provider Rejection。

Accepted Receipt 必须回显 Lease 的 Logical Result ID 和 Segment Index。Receipt 不匹配或出现意外 Exception 时记为 `ambiguous`。Provider 明确拒绝则为终态。Deferred 与 Ambiguous Record 保留相同 Logical Result 和 Outbox Identity，并使用带 Jitter 的有界指数 Retry；Adapter 提供的 Retry Delay 在当前一小时上限内作为最小值。

Provider Message ID 和 Delivery Body 只保留在 Profile Database 内。Operational Log 与 Channel Status Output 必须使用内部 Reference 和稳定 Reason Code。

## Schema 与当前限制

新数据库使用 Bridge Schema Version 8。旧 Database 会以 Profile Reason `migration_required` 失败关闭；正常 Service Startup 不会修改它们。Host-local [`migrations.md`](migrations.md) Workflow 通过 Snapshot Evidence、完整 Plan Confirmation、事务化 Backfill/Rebuild、验证和不含内容的 Audit Record，显式支持 Schema 3、4、5、6 或 7→8。

Schema Version 8 为每个 Outbox Target 增加可选的 WhatsApp Quoted-reply Participant 与 Original-text Fact。这些 Field 进入 Logical Result Digest 并跨 Restart 保留。Adapter 只在 Send 时重建最小 Baileys Quote Object；QQ 忽略这些 Optional Field。

Approval Prompt 是第三种 Logical Result Source Kind。Approval Request、Prompt Logical Result、Outbox Record 与不含正文的 Requested Audit Record 在同一 Transaction 提交。Presentation Settlement 会在 Outbox Transaction 内更新 Approval Record；Terminal Callback、Timeout 与 App Server Generation Loss 会拒绝尚未发送的 Approval Outbox Work，避免 Native Request 消失后继续展示失效 Token。

当前 Outbox 已提供持久通用投递和 Crash-safe Lease Recovery。对于 QQ 被动投递，同一 Transaction 会为每个 `msg_id` 分配并保存正整数 `msg_seq`；后续共享该 Anchor 的 Logical Result 会继续递增。所有 Ambiguous Retry 都复用同一个 Pair，QQ Adapter 使用显式 Raw-send Path，不再允许 SDK Helper 临时生成新序号。

这消除了 Identity Drift，但没有解决 Provider Reconciliation。如果 QQ 已接受发送、Response 却丢失，Bridge 使用相同 Pair 重试后可能只得到拒绝，而没有 Lookup API 可以证明原消息是否已经可见。主动降级发送也没有 Documented Idempotency Identity。因此项目仍披露 Ambiguous/Duplicate Window，不宣称 QQ 达到 Strict Exactly-once Delivery。

## 验证

Unit Interface 覆盖 Atomic Commit 与 Deduplication、冲突重放、Segment Ordering、Durable Reopen、Lease Expiry、拒绝旧 Settlement、Ambiguous Retry、Definite Rejection Cascade、Adapter Unavailability、Receipt Correlation 和 Non-overlapping Sweep。Platform Acceptance 在原生 macOS、原生 Linux 和 Linux Docker 上运行同一套 Suite。
