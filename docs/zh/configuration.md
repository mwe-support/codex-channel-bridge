# 配置与 Supervisor 运行

## 配置来源

当前开发版 Supervisor 读取一个由管理员选择的绝对 `config.yaml` 路径。它绝不在仓库、Workspace、当前目录或 Profile 目录中搜索配置文件或 dotenv 文件。

使用 `config.example.yaml` 作为不含 Secret 的结构参考。配置只能包含 Bridge 设置。本阶段尚未包含 Credential 和 Secret Reference 字段，未知字段会导致验证失败。

## Schema

```yaml
schemaVersion: 1

supervisor:
  drainTimeoutMs: 300000
  childExitTimeoutMs: 10000

profiles:
  primary:
    enabled: true
    workspace: /absolute/path/to/workspace
    codexHome: /absolute/path/to/codex-home
    codexExecutable: /optional/absolute/path/to/codex
```

Profile Mapping 的 Key 是 Profile ID。ID 使用小写 ASCII 字母、数字和连字符，以字母开头，最长 63 个字符。`workspace` 和 `codexHome` 必须是现有绝对目录，并且在完整 Candidate 中分别由一个 Profile 独占。`codexExecutable` 可选；省略时，Worker 从其 Service Environment 中解析 `codex`。Bridge 不会安装或升级它。

移除 Profile 或设置 `enabled: false` 会停止其 Worker，但不会删除 Workspace、Codex home、Bridge Data 或未来的 Channel Authentication State。永久 Purge 仍是独立的未来 Host-local Operation。

## 环境变量覆盖

进程环境通过一个可选 JSON Object 覆盖 YAML：

```sh
BRIDGE_CONFIG_OVERRIDES_JSON='{"profiles":{"primary":{"enabled":false}}}'
```

Object 按 Key 递归合并，因此 Profile ID 保持稳定，也不需要 Array Index 约定。完整合并后的 Candidate 会作为整体进行验证。空值、格式错误、未知或不完整的 Override Data 会拒绝该 Candidate，并且不会生成 Configuration Revision。

此变量只用于不含 Secret 的配置。实现 Channel Account 后，Channel Credential 将使用另行规定的 Secret Reference 与 Profile `secrets.env` 机制。

## 只读验证

构建仓库后运行：

```sh
node packages/cli/dist/main.js config check \
  --config /absolute/path/config.yaml
```

该命令解析不允许 Alias 的 YAML、应用 Environment Override、拒绝未知 Key、验证所有 Profile Path，并且只输出 Revision、Profile ID 和 Enabled State。它不会启动、停止、修复或修改 Profile。

## 前台 Supervisor

显式启动开发版 Supervisor：

```sh
node packages/cli/dist/main.js supervisor run \
  --config /absolute/path/config.yaml \
  --endpoint /absolute/path/control.sock
```

该命令接受已经验证的 Candidate 作为初始 Configuration Revision，为每个 Enabled Profile 启动一个 Worker 子进程，并保持前台运行。JSON Output 报告不含内容的 Profile Health 和 Supervisor Lifecycle Event。一个 Unavailable Profile 不会使 Supervisor Liveness 失败，也不会停止健康的 Sibling。

`SIGINT` 和 `SIGTERM` 触发相同的有界停止路径：Worker 收到 Stop Request，随后 Supervisor 使用配置的 Drain Timeout 和 Child-exit Timeout，超时后才强制终止。

## Host-local Control Plane

运行中的 Supervisor 通过一个 Host-local Endpoint 暴露版本化 JSONL Administration Protocol。它不监听 TCP 或 HTTP。在 macOS 和 Linux（包括 Docker）上，默认 Endpoint 是平台临时目录下的 Owner-only Unix Socket。其父目录必须由 Service User 拥有且 Mode 为 `0700`，Socket 必须由该用户拥有且 Mode 为 `0600`。已有的活动 Endpoint 绝不被替换。

向 Supervisor 与 CLI 传入相同的显式 Endpoint，或在两个进程环境中都设置 `BRIDGE_CONTROL_ENDPOINT`：

```sh
node packages/cli/dist/main.js status \
  --endpoint /absolute/path/control.sock
```

当前 Node.js Runtime 不暴露 Unix Peer Credential。因此，本阶段把通过经过验证的 Owner-only Directory 和 Socket 成功访问视为本地 System Administrator Identity，同时仍对每个 Request 执行 Authorization Hook。Native Peer-credential Verification 是发布前尚待完成的平台边缘。Windows Named-pipe Endpoint 的结构已经存在，但严格 ACL 的配置和验证尚未在 Windows 上测试，因此不宣称已经完成。

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

第二次调用重新读取并验证完整 Candidate，拒绝不同的 Revision，并向 Supervisor 发送一个短生命周期、只能使用一次的 Plan Token 和完整 Revision。如果这期间已经接受另一个 Configuration Revision，Stale Plan 会被拒绝。配置接受后，受影响的 Profile 独立 Transition；未变化的 Profile 不会重启。

进程绝不监视 `config.yaml`、不把 SIGHUP 当作 Reload，也不接受第二个进程直接修改 Supervisor State。
