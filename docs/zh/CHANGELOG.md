# 变更日志

本文档记录 Codex Channel Bridge 面向用户的变更。发布版本遵循
[语义化版本](https://semver.org/lang/zh-CN/)，具体流程见
[`release.md`](release.md)。

## [Unreleased]

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
