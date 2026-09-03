# 配置与 Supervisor 运行

## 配置来源

当前开发版 Supervisor 读取一个由管理员选择的绝对 `config.yaml` 路径。它绝不在仓库、Workspace、当前目录或 Profile 目录中搜索配置文件或 dotenv 文件。

使用 `config.example.yaml` 作为不含 Secret 的结构参考。配置只能包含 Bridge 设置和 Secret Reference。Credential Value 绝不是合法配置字段，未知字段会导致验证失败。

## 交互式设置

当前 `main` 分支为下一个版本提供两种交互式入口：

```sh
bridge setup quick
bridge setup full --config /absolute/path/config.yaml
```

快速设置只询问一个 Profile 的路径、要启用的 Channel、Account ID 与私聊访问规则，
Admission、Approval、Media、Supervisor 时序、群 Thread Scope 与默认拒绝的群访问均
采用已校验的 Schema 默认值。完全设置会进一步开放这些设置和三类访问规则。两种
模式生成的都是 `config check` 与 Supervisor 直接使用的同一份规范
`config.yaml`，不会产生第二套设置存储。

CLI 会先展示完整且不含 Credential Value 的候选配置，确认默认值为 `no`；它拒绝
覆盖已有配置，以 Owner-only 权限创建 Profile State Directory，并原子写入新配置。
QQ 快速设置使用 `env:QQ_BOT_APP_ID` 和 `env:QQ_BOT_APP_SECRET`，向导不会询问或
写入真实 Credential Value。WhatsApp Authentication 仍由后续 Host-local Pairing
命令创建。不可变的 `v0.1.0-rc.4` tag 不包含这些命令。

## Schema

```yaml
schemaVersion: 1

supervisor:
  drainTimeoutMs: 300000
  childExitTimeoutMs: 10000
  codexRestartCooldownMs: 30000
  diskSafetyFloorBytes: 536870912

profiles:
  primary:
    enabled: true
    workspace: /absolute/path/to/workspace
    codexHome: /absolute/path/to/codex-home
    stateDirectory: /absolute/path/to/bridge-state
    secretsFile: /absolute/path/to/bridge-state/secrets.env
    admission:
      mode: steer
      maximumActiveTurns: 1
      queueCapacity: 16
      maximumQueueAgeMs: 300000
      accountRateLimit: 30
      accountRateWindowMs: 60000
    approval:
      timeoutMs: 300000
      detail: minimal
    media:
      perAttachmentLimitBytes: 67108864
      profileQuotaBytes: 10737418240
    channelAccounts:
      qq-primary:
        provider: qq
        enabled: true
        epochId: initial
        appId: env:QQ_BOT_APP_ID
        appSecret: file:/run/secrets/qq-bot-app-secret
        groupThreadScope: conversation
        accessPolicy:
          privateChats:
            mode: allowlist
            allow: [provider-private-identity]
          groupChats:
            mode: allowlist
            allow: [provider-group-conversation-id]
          groupParticipants:
            mode: allowlist
            allow: [provider-group-participant-id]
    codexExecutable: /optional/absolute/path/to/codex
```

`codexRestartCooldownMs` 是 App Server 有界重启预算耗尽后使用的 Profile-local Circuit Breaker Cooldown。每个新 Generation 必须重新完成完整 Capability Probe 后才能进入 Ready。

`diskSafetyFloorBytes` 为 Bridge Durable State 保留 Deployment Storage。低于该阈值时，Profile 会拒绝新 Work、停止 Media Mirroring、断开 Channel Adapter，并报告 `unavailable: storage_pressure`；当 Message Archive 无法安全 Commit 时，绝不声称 Event 已持久化。

Profile Mapping 的 Key 是 Profile ID。ID 使用小写 ASCII 字母、数字和连字符，以字母开头，最长 63 个字符。`workspace`、`codexHome` 和 `stateDirectory` 都必须是现有绝对目录；在完整 Candidate 中，任何一个 Owned Root 都不能与另一个相同，也不能包含另一个或被另一个包含。在 macOS 和 Linux 上，`stateDirectory` 必须是真实目录、由 Service User 所有且 Mode 为 `0700`；Worker 在其中创建 Mode 为 `0600` 的 `bridge.sqlite`。`codexExecutable` 可选；省略时，Worker 从其 Service Environment 中解析 `codex`。Bridge 不会安装或升级它。

`secretsFile` 默认是 `stateDirectory/secrets.env`。覆盖时必须显式提供绝对路径；Bridge 绝不搜索 Dotenv File。不同 Profile 不能共享同一个 Secret File，也不能让该文件与其他 Profile 的 Workspace、Codex home 或 State Boundary 重叠。`channelAccounts` 以整个 Deployment 范围内唯一的 Channel Account ID 为 Key。当前阶段接受 QQ 与 WhatsApp Account。每个 Account 都有 Operator 选择的 Epoch ID，用于 Durable Deduplication。即使某个 Account 的其他字段无效，同一 Channel Account ID 也不能出现在两个 Profile 中。WhatsApp Rotating Authentication 只从固定 Profile-local Path `stateDirectory/channel-auth/CHANNEL_ACCOUNT_ID` 加载；它不是 Secret Reference，也绝不写入 `config.yaml`。

`appId` 和 `appSecret` 只接受 `env:NAME` 或 `file:/absolute/path` Secret Reference。`env:` Reference 先从真实 Service Process Environment 解析，再回退到该 Profile 配置的 `secretsFile`。`file:` Reference 从一个绝对路径文件读取单个 Secret。在 macOS 和 Linux 上，这两类文件都必须是普通、非 Symlink、由 Service User 所有且 Mode 严格为 `0600` 的文件。缺失、空、Malformed 或 Insecure Input 会让受影响 Adapter 保持 Unavailable，且不披露名称或值。

`accessPolicy` 失败关闭。三个独立 Rule 默认均为 `deny`，可设置为 `deny`、`allowlist` 或 `open`。私聊 Rule 比较稳定 Provider Identity。群 Event 必须同时通过使用 Provider Conversation ID 的群会话 Rule，以及使用 Provider Identity 的群参与者 Rule。`allowlist` 至少包含一个精确 Identifier；`deny` 与 `open` 不得携带 `allow` List。`groupThreadScope` 默认为 `conversation`；设置为 `participant` 时，每个获准群成员具有独立 Codex Thread Binding。

Profile-local `admission` 默认使用 Steer Mode、最多一个 Active Turn、16 条 Queue 容量、五分钟最大 Queue Age，以及每个 Channel Account 每 60 秒 30 条 Ordinary Input。只有 `mode: queue` 才会使用 Queue。所有限制都位于 Access Policy 与 Command Parsing 之后、原生 Codex Work 之前。Runtime 语义见 [`admission.md`](admission.md)。

Profile-local `approval` 默认使用五分钟 Response Window 与 `minimal` Presentation。`detail` 接受 `minimal`、`summary` 或 `detailed`。Minimal Mode 只暴露 Native Operation Class 与 Opaque Response Token；Summary 可以包含有界的 Reason 与 Command Summary；Detailed 可以在 Codex 提供时额外包含有界的 Native Command、Working Directory 或 Requested Write Root。Bridge 永不把 Process-scoped JSON-RPC Request ID 发送到 Channel。参见 [`approval-routing.md`](approval-routing.md)。

Profile-local `media` 默认限制为单 Attachment 64 MiB、单 Profile 已镜像 Byte 10 GiB。`perAttachmentLimitBytes` 与 `profileQuotaBytes` 必须是正整数，且 Profile Quota 不能小于单 Attachment Limit。这两个值只限制已镜像 Byte；超过限制或无法获取 Byte 时，Attachment Metadata 仍保留在 Message Archive 中。

Dotenv Parser 接受普通 `KEY=VALUE` Record 和使用单引号或双引号包裹的 Literal Value。它不执行 Shell Syntax、不展开 Variable、不进行 Command Substitution，也不包含其他文件。不要提交真实 `secrets.env`；普通 Secret File Name 和 `test-channel.env*` 已被本仓库忽略。

移除 Profile 或设置 `enabled: false` 会停止其 Worker，但不会删除 Workspace、Codex home、Bridge Data 或 Channel Authentication State。永久 Purge 仍是独立、需要显式确认的 Host-local Operation。

## 环境变量覆盖

进程环境通过一个可选 JSON Object 覆盖 YAML：

```sh
BRIDGE_CONFIG_OVERRIDES_JSON='{"profiles":{"primary":{"enabled":false}}}'
```

Object 按 Key 递归合并，因此 Profile ID 保持稳定，也不需要 Array Index 约定。完整合并后的 Candidate 会作为整体进行验证。空值、格式错误、未知或不完整的 Override Data 会拒绝该 Candidate，并且不会生成 Configuration Revision。

此变量只用于不含 Secret 的配置与 Secret Reference。真实 Credential Value 仍必须位于 Process Environment、显式 Profile `secretsFile` 或 Owner-only `file:` Target 中。

## 只读验证

运行：

```sh
bridge config check \
  --config /absolute/path/config.yaml
```

该命令解析不允许 Alias 的 YAML、应用 Environment Override、拒绝未知 Key、验证所有 Profile Path，并且只输出 Revision、Profile ID 和 Enabled State。它不会启动、停止、修复或修改 Profile。

## 前台 Supervisor

显式启动开发版 Supervisor：

```sh
bridge supervisor run \
  --config /absolute/path/config.yaml \
  --endpoint /absolute/path/control.sock
```

该命令接受已经验证的 Candidate 作为初始 Configuration Revision，为每个 Enabled Profile 启动一个 Worker 子进程，并保持前台运行。JSON Output 报告不含内容的 Profile Health 和 Supervisor Lifecycle Event。一个 Unavailable Profile 不会使 Supervisor Liveness 失败，也不会停止健康的 Sibling。

`SIGINT` 和 `SIGTERM` 触发相同的有界停止路径：Worker 收到 Stop Request，随后 Supervisor 使用配置的 Drain Timeout 和 Child-exit Timeout，超时后才强制终止。

## Host-local Control Plane

运行中的 Supervisor 通过一个 Host-local Endpoint 暴露版本化 JSONL Administration Protocol。它不监听 TCP 或 HTTP。在 macOS 和 Linux（包括 Docker）上，默认 Endpoint 是平台临时目录下的 Owner-only Unix Socket。其父目录必须由 Service User 拥有且 Mode 为 `0700`，Socket 必须由该用户拥有且 Mode 为 `0600`。已有的活动 Endpoint 绝不被替换。

向 Supervisor 与 CLI 传入相同的显式 Endpoint，或在两个进程环境中都设置 `BRIDGE_CONTROL_ENDPOINT`：

```sh
bridge status \
  --endpoint /absolute/path/control.sock
```

当前 Node.js Runtime 不暴露 Unix Peer Credential。因此，本阶段把通过经过验证的 Owner-only Directory 和 Socket 成功访问视为本地 System Administrator Identity，同时仍对每个 Request 执行 Authorization Hook。Native Peer-credential Verification 是发布前尚待完成的平台边缘。Windows Named-pipe Endpoint 的结构已经存在，但严格 ACL 的配置和验证尚未在 Windows 上测试，因此不宣称已经完成。

### WhatsApp Account Lifecycle

同一个 Owner-only Endpoint 承载一组封闭的 Typed WhatsApp Lifecycle Operation。每个 Operation 都明确指定一个 Profile 与其独占绑定的 Channel Account。Pairing 要求 Interactive TTY；Raw Expiring QR Value 只存在于该 Request Connection，并由本地 CLI 渲染。Account 存在 Active/Queued Work、Pending Approval Request 或 Pending Outbox Delivery 时，Lifecycle Change 会失败关闭。

```sh
bridge whatsapp pair --profile alpha --account wa-primary
bridge channel disconnect --profile alpha --account wa-primary
bridge channel connect --profile alpha --account wa-primary
bridge whatsapp logout --profile alpha --account wa-primary
bridge whatsapp forget-local \
  --profile alpha --account wa-primary --confirm wa-primary
```

`disconnect` 可逆。固定 Provider API 不能独立确认 Remote Logout，因此 `logout` 返回 `logout_uncertain`，停止 Automatic Reconnect，并保留 Local State。只有该结果之后才能执行 `forget-local`；它要求完整 Account ID，且不宣称 Remote Invalidation。每次 Attempt 都写入不含正文的 Profile-local Audit Record。

## 显式应用运行时配置

运行时配置变更使用两次 CLI 调用。第一次在运行中的 Supervisor 进程内重新读取 Candidate、应用其 Environment，并返回脱敏 Transition Plan，不改变 Runtime State：

```sh
node packages/cli/dist/main.js config apply \
  --config /absolute/path/config.yaml \
  --endpoint /absolute/path/control.sock
```

把完整的 `confirmationRequired` Revision 复制到第二次调用：

```sh
node packages/cli/dist/main.js config apply \
  --config /absolute/path/config.yaml \
  --confirm FULL_CANDIDATE_REVISION \
  --endpoint /absolute/path/control.sock
```

第二次调用重新读取并验证完整 Candidate，拒绝不同的 Revision，并向 Supervisor 发送一个短生命周期、只能使用一次的 Plan Token 和完整 Revision。如果这期间已经接受另一个 Configuration Revision，Stale Plan 会被拒绝。配置接受后，受影响的 Profile 独立 Transition；更改 `stateDirectory`、`secretsFile` 或任何 Channel Account 只会重启该 Profile，未变化的 Profile 不会重启。Plan 与 Apply Output 绝不包含解析后的 Secret Name 或 Value。

进程绝不监视 `config.yaml`、不把 SIGHUP 当作 Reload，也不接受第二个进程直接修改 Supervisor State。
