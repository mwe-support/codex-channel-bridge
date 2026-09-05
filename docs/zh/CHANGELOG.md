# 变更日志

本文档记录 Codex Channel Bridge 面向用户的变更。发布版本遵循
[语义化版本](https://semver.org/lang/zh-CN/)，具体流程见
[`release.md`](release.md)。

## [Unreleased]

## [0.2.0-rc.1] - 2026-09-05

### 新增

- 增加官方维护的 POSIX 与 Windows 一键安装器：验证准确发布版本的校验和与包内
  版本，保留旧版本并原子切换 `bridge` 启动器，同时绝不安装或升级 Codex。
- 增加交互式 `bridge setup quick` 与 `bridge setup full`：预览并原子写入规范
  配置，同时不收集 Secret Value。
- 增加仅绑定 Loopback 的本地 Dashboard，用于查看运行中的 Bridge 版本、Host 与
  Profile Health、Channel Connectivity、有界且不含内容的 Event，并复用现有需
  确认的 Configuration Plan/Apply 流程。
- 增加 `bridge --version`，无需启动 Supervisor 即可报告实际运行的 Bridge
  版本。
- 记录使用已核验 Checksum 的 WinSW `2.12.0` 完成一次性原生 Windows Service
  安装、前台 Supervisor 启动、Named Pipe Status、有界停止、卸载与清理验收。
- 不同会话默认可并发启动 Codex Turn，不受 Profile 全局上限限制；仍保留显式
  可选上限与有界队列。
- 无参数 `/model` 和 `/reasoning` 查询绑定 Codex Thread 的原生设置；带参数
  形式继续只修改该 Thread。
- QQ 私聊使用腾讯原生回复流；QQ 群聊与 WhatsApp 保持完整终态回复，WhatsApp
  另提供尽力而为的输入中提示。
- 对原生 Codex 命令/文件审批请求，在 QQ 与 WhatsApp 中进行关联处理，包含取消
  和过期清理。
- 可选地识别完成回复中的工作区本地 Markdown 文件链接，生成不可变快照并通过
  Durable Outbox 自动投递。
- 增加版本化中英双语 Docusaurus 文档站，保留不可变预发布手册与 `Next` 文档线。

### 修复

- 修复 Setup 与 Bridge 自有持久文件写入在 Windows 上的兼容性；Windows 无法对
  Directory Handle 执行 `fsync`。
- 统一 Windows 下生成文档所用的 Path Separator，并让 App Server Process 与
  Local Control-plane Lifecycle Contract 可在 Windows 原生运行。
- Supervisor 停止时关闭仍存在的 Local Control Connection，避免空闲 Named-pipe
  Client 阻止 Process 退出。
- 使用随项目提供的 Helper 替换 Node 默认的 Windows Named-pipe Listener；Helper
  在接受 Control Request 前，为 Service Identity、LocalSystem 与
  BUILTIN\Administrators 创建并验证 Protected ACL。

### 变更

- Profile schema 9 增加 Archive 附件元数据，schema 10 增加 QQ 原生回复流关联，
  schema 11 增加不可变输出文件元数据。升级仍必须显式 plan、snapshot 并确认。
- 并发工作时保持无关 Channel Conversation 相互独立，并在 Codex 解决请求或
  Turn 结束时关闭进程范围审批状态。

### 候选发布边界

- 这是候选发布版，不是稳定生产版本；其准确代码树作为下一轮验收基线。
- macOS 上 QQ 与 WhatsApp 私聊/群聊真实输出文件下载均与源文件和 Outbox 摘要
  一致；该附件链路的原生 Linux、Linux Docker 与 Windows 验收仍待完成。
- WhatsApp 输入中提示的可见性/清理、独立 Turn 中断，以及 QQ 原生流的剩余
  过期/限流/重启/并发场景仍未完成，虽然确定性契约已经通过。
- Dashboard 显示版本、Health、Channel Connectivity、有界本地 Event，并可确认
  应用配置；YAML 编辑、Profile 实时日志、重启控制与会话管理仍是未来需求。
- 不包含 Channel Account 全局模型/思考强度管理，也不包含宿主 Codex App 会话投射。

## [0.1.0-rc.4] - 2026-09-02

### 修复

- Release Job 显式 Checkout Git Tag Ref，避免 `actions/checkout` 在验证前
  使用事件的 Peeled Commit 替换本地 Ref，从而保留附注 Tag Object。

### 包含内容

- 包含 `0.1.0-rc.1` 下记录的全部 Bridge 能力与候选发布版边界，以及
  `0.1.0-rc.2`、`0.1.0-rc.3` 的 CI 修复。此前所有不可变 Tag 均作为 CI
  失败候选保留，且没有生成 GitHub Release。

## [0.1.0-rc.3] - 2026-09-02

### 修复

- 真实 Supervisor Process Contract 继续作为宿主发布门禁，但不再由缺少
  Administrator-supplied Codex CLI、且不得自行安装 Codex 的通用 GitHub
  Runner 执行。

### 包含内容

- 包含 `0.1.0-rc.1` 下记录的全部 Bridge 能力与候选发布版边界，以及
  `0.1.0-rc.2` 的有界测试等待修复。前两个不可变 Tag 均作为 CI 失败候选
  保留，且没有生成 GitHub Release。

## [0.1.0-rc.2] - 2026-09-02

### 修复

- Supervisor 重启测试改为按有界实际经过时间等待，不再固定等待少量 Event-loop
  Turn。这样可避免异步文件系统操作耗时数毫秒时出现仅 CI 可见的失败；Production
  Restart 行为没有变化。

### 包含内容

- 包含 `0.1.0-rc.1` 下记录的全部 Bridge 能力与候选发布版边界。不可变
  `v0.1.0-rc.1` Tag 作为 CI 失败的候选记录保留，且没有生成 GitHub Release。

## [0.1.0-rc.1] - 2026-09-02

### 新增

- 增加独立的多 Profile Supervisor；每个 Profile Worker 分别拥有自己的
  Codex App Server Child、WAL-mode SQLite 状态、QQ Adapter 与 WhatsApp
  Adapter。
- 增加持久入站去重、Access Policy 与 Admission Control、原生 Thread
  Start/Steer、Thread Binding、Logical Result、事务 Outbox 投递、Provider
  Receipt 与重启对账。
- 增加 Host-local 管理能力，覆盖配置、迁移、Profile 生命周期、WhatsApp
  配对与撤销、诊断、备份协调、Audit Record、Support Bundle、Archive
  检索与清理，以及 Circuit 恢复。
- 增加原生 launchd、systemd Service Packaging 与非 root Linux Docker
  Image；Stage 8 已在 macOS、Linux 和 Linux Docker 完成验收。
- 增加原生 Model 与 Reasoning Selection、Channel Thread Command、关联到
  原请求的 Codex Approval Request Transport，并在 Stage 8 Runtime Baseline
  完成真实 QQ 与 WhatsApp 私聊/群聊交互验收。
- 增加仓库级版本一致性门禁、附注 Git tag、不可变 GitHub Release
  源码包与校验和，以及文档和发布版本严格匹配的规则。
- 增加固定 Commit 的 Hermes Agent 与 OpenClaw 文档技术栈调研，并同步维护
  中英文报告。

### 变更

- 删除推测性 Wrapper，并合并共用的配置、存储、Control Plane 与 Worker
  路径，以精简 Bridge 实现。

### 候选发布版边界

- 本版本用于验收准确 Tag Tree，是预发布版，不是稳定生产版本。
- 原生 Windows Service 与 Named-pipe ACL 尚未完成验收。
- `/attach` 已有 Contract Coverage，但尚未通过真实 QQ 客户端验收。
- 真实 WhatsApp、原生 Linux 和 Linux Docker 已在 Stage 8 Baseline 通过；
  针对本 Tag 准确代码树的重构后复验仍待完成。
- Release 包含版本匹配的 Markdown 文档，但尚未发布规划中的版本化
  Docusaurus 站点。
