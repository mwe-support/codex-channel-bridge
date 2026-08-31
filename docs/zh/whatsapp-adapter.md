# WhatsApp Adapter 基线

## 固定 Provider Library

首个实现阶段固定 `baileys@7.0.0-rc14`。该 Package 由官方 `WhiskeySockets/Baileys` Repository 发布，使用 MIT License。Package 要求 Node.js 20 或更高版本；Bridge 已要求 Node.js 22 或更高版本。

Adapter 遵循固定 Source Contract：

- 一个 `makeWASocket` Instance 只属于一个 Channel Account Adapter；
- Live Message 通过 `messages.upsert` 到达；
- `creds.update` 后保存 Rotating Credential；
- Readiness 跟随 `connection.update`；
- 意外且可重试的断开会按 1、2、5 秒的有界延迟和有界抖动更换 Socket；
- Text Delivery 使用 `sendMessage(jid, { text })`，并要求返回 Provider Message ID。

实现禁用 History Sync。Adapter 只接受 Type 为 `notify` 的 `messages.upsert` Event，并丢弃携带 `requestId` 的 Event；这与近期 Baileys Release 针对 Placeholder-resend Spoofing 的上游缓解一致。Own Message、Status/Broadcast/Newsletter JID，以及缺少 Durable Deduplication 所需 Identity 的 Provider Event 也会被忽略。

## Channel-neutral 投射

Private 与 Group Message 会转换为 QQ 同样使用的 `ProviderInboundEvent`。WhatsApp JID 保持为 Provider-owned Identity。Device Suffix 会规范化；Group Conversation JID 与 Participant JID 仍保持不同。只有 Baileys Context 指明提及当前已连接账号时，Group Message 才是 Active；其余 Group Message 只作为 Passive Observation 归档。

Outbound Text 使用现有 `ChannelTextDelivery` Contract。当 Inbound Text Message 是 Delivery Anchor 时，Inbound Pipeline 会把 Provider Message ID、Participant Identity 与有界 Original Text 带入 Transactional Outbox。即使重启，Adapter 也能重建固定 Baileys Source 所需的 `quoted` Input，而不持久化 Baileys Runtime Object。没有 Provider Message ID 的 Response 和所有抛出的 Send Error 都被视为 Ambiguous，因为 Web Protocol 没有向 Bridge 提供 Idempotent Send Key 或确定 Reconciliation Lookup。Retry 因此保留已经披露的小重复窗口。

## Authentication State

Bridge 不使用 Baileys Example `useMultiFileAuthState`，因为其 Source 本身不建议把它用于 Production。`openBaileysAuthState` 把 Rotating Credential 与 Signal Key 存在固定 Profile Path `stateDirectory/channel-auth/CHANNEL_ACCOUNT_ID` 下。

在 macOS 和 Linux 上，Directory 必须是真实、由 Service User 所有且 Mode 为 `0700` 的目录；每个 State File 必须是普通、非 Symlink、Owner-only `0600` 文件，并限制为 16 MiB。Write 使用同目录 Exclusive Temporary File、Flush、Atomic Rename 与 Directory Flush。Signal-key Write 按 File 串行化。该 Runtime API 拒绝 Clear，清理仍只属于显式 Logout/Revoke Workflow。

Account Directory 是 Generation Store。每个 Generation 都是包含一套完整 Baileys State 的 Owner-only Directory。普通 Profile Worker 只打开 Owner-only `active-generation.json` Marker 指定的 Generation，绝不创建 Pairing State、展示 QR 或跨 Profile 复制 Auth。原子替换这个小 Marker 可以激活已注册的 Staged Generation，而不修改之前的 Active State。

`pairWhatsAppAccount` 实现 Provider-facing Pairing Transaction。它创建独立 Staged Generation，只通过调用方提供的 Presentation Callback 投射短期 QR Material，持久化 Rotating Credential，处理有界 `restartRequired` Sequence，并要求 Connected Socket 证明规范化 Provider Identity。Reauthentication 必须匹配 Expected Identity；Identity Mismatch、Timeout、Cancellation、Presentation Failure 或 Connection Failure 都会保留旧 Active Marker 并删除 Staged Generation。该 Module 把 Raw QR 与 Provider Identity 视为 Sensitive，绝不写入 Log、Audit 或 Message Archive。

## Host-local Lifecycle Control

`WhatsAppChannelAccount` 是 Inner Adapter 之上的深 Lifecycle Boundary。Profile Worker 会先证明所选 Account 没有 Active/Queued Input、Pending Approval Request，以及 Pending、Leased 或 Retry-wait Outbox Record，然后记录不含正文的 `started` Audit Record，并执行 Connect、Disconnect、Pair、Logout 或 Forget-local 之一。

Pairing 使用 Staged Transaction，并且只替换该 Account 的 Inner Adapter。Expiring QR Event 沿 Correlated Worker IPC Request 和同一 Unix-socket JSONL Connection 返回发起操作的 Interactive CLI；CLI 渲染可扫描 QR，但不打印 Raw Value。Disconnect 保留 Binding 与 Auth State。

固定 Baileys 的 `logout()` 实现会发送 `remove-companion-device` Node，但不提供独立 Remote-confirmation Receipt。因此成功调用仍记录为 `logout_uncertain`，Adapter 保持停止，Owner-only Revocation Marker 阻止普通 Reconnect。只有处于该 Uncertain State 才能执行 `forget-local`，且必须确认完整 Channel Account ID；该操作原子删除本地 Baileys Account Root，但明确不能证明远端已失效。

```sh
bridge whatsapp pair --profile PROFILE --account ACCOUNT
bridge channel disconnect --profile PROFILE --account ACCOUNT
bridge channel connect --profile PROFILE --account ACCOUNT
bridge whatsapp logout --profile PROFILE --account ACCOUNT
bridge whatsapp forget-local --profile PROFILE --account ACCOUNT --confirm ACCOUNT
```

## 重连监督

发生意外且可重试的断开后，Adapter 会丢弃旧 Socket，并在有界延迟后为同一
Channel Account 创建新 Socket。只有当前 Socket Generation 的事件可以进入
Inbound Pipeline，因此被替换 Socket 的迟到事件不会被接受。成功 Open 会重置
Attempt Budget。

默认 Budget 是三次，延迟分别为 1、2、5 秒并带有界抖动。Baileys
`restartRequired` 也消耗同一个有限 Budget，但会立即重连。`loggedOut`、
`badSession`、`connectionReplaced`、`multideviceMismatch` 和 `forbidden` 是
Fail-closed Administrator State，不会自动重连。重试耗尽只使该 Adapter
Degraded，不会停止 Profile App Server 或 Sibling Adapter。主动 Stop 会取消
Pending Retry，Stale Socket Callback 会被忽略。
Channel-neutral Readiness Subscription 会把断开、恢复与重试耗尽投射到 Profile
Health，使 Supervisor 能看到 `degraded` 和之后恢复为 `ready`，而不会把 Worker
视为失败。

## 当前限制

- Pairing、Single-adapter Replacement、Disconnect、Logout Uncertainty、Forget-local 与 Durable Text Quote 已实现。Repository Acceptance Test 不会配对真实 WhatsApp Account。
- Media Decryption 与有界 Content-addressed Mirroring 留在 Archive/Media Stage；Send Acceptance 之外的 Receipt 仍属后续工作。
- 固定 Baileys Declaration Bundle 含有上游 NodeNext Declaration 缺陷。只有该 Package 启用 `skipLibCheck`；其 Public Declaration 使用 Bridge-owned Structural Type，因此例外不会传播到其他 Package。固定 Dependency 发布干净 Declaration 后应移除此例外。
