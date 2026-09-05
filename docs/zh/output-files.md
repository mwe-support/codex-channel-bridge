# 自动输出附件

状态：已纳入候选版 `0.2.0-rc.1`，FR-010 的跨平台验收仍待完成。
现有数据库部署前须完成[显式 schema 11 迁移](migrations.md)。

## 启用与使用

在 `config.yaml` 对应 Profile 中合并 `media.sendOutputFiles: true`，然后运行
`bridge config check` 与需要确认的 `bridge config apply`。此变更会 drain/restart
该 Profile。默认 `false`；快速设置保持关闭，完全设置提供选项。关闭后不再准备新
附件，但不会取消已经提交的 Outbox 投递。

要求 Codex 在 Workspace 内生成文件，并在最终回复附 Markdown 下载链接，例如
`[报告](output/report.pdf)` 或 `[报告](</absolute/workspace/output/report with spaces.pdf>)`。
Bridge 自动创建快照并向**原会话**发送附件，无需 `/file` 命令或逐次确认。
群聊中，能阅读该会话的其他群成员也可能接收文件。

这是对该 Profile 工作区的导出授权，不证明文件是本次新建或内容不敏感。仅对适合
当前参与者访问的工作区启用。共享 OS 用户的应用层隔离不能抵御恶意本地进程修改工作区。

## 识别范围与限制

- 只处理已完成最终回复中的本地行内 Markdown 链接/图片。普通路径、引用式链接、
  围栏代码、缩进代码、包含行内反引号的行、引用行、转义链接与 HTML 代码块不触发
  导出。忽略网页 URL 和带 query/fragment 的链接；不扫描工作区或从工具/文件修改
  事件提取附件。
- 每条回复最多考虑三个不同链接目标。相对路径基于 Profile Workspace，不是工具
  临时切换的工作目录。
- 必须为工作区内非空普通文件，不允许任意路径组成部分为符号链接或文件存在硬链接。
  排除隐藏路径、常见 secret/auth/env/key 名称、Codex home、Bridge state 及配置的
  secret 文件。这不是内容检查或通用密钥检测系统。
- 单文件上限取 `perAttachmentLimitBytes` 与 64 MiB 的较小值。输出快照与入站镜像
  共用 `profileQuotaBytes` 并遵守磁盘安全余量；二者串行写入。空间不足时不准备附件，
  保留文字回复并附明确提示。容量判断保守预留完整文件大小，即使内容可能已存储。

## 持久化与平台语义

快照存放在 Profile 的 `stateDirectory/outbound-files/`，以 SHA-256 命名，仅服务用户
可访问。先 flush 快照，再在**同一个 Logical Result / Outbox 事务**提交最终文字与
文件元数据。重试读取并校验快照，不重新读取原工作区路径；原文件修改/删除不改变
已提交附件。快照缺失或损坏时失败关闭；沿用现有顺序、epoch 校验、回执、退避与
不确定发送处理。

QQ SDK 1.0.4 使用 `srvSendMsg: false` 上传，再携带持久回复序号发送 `msg_type: 7`。
重试重新上传，不缓存过期 `file_info`。回复锚点明确过期时尝试现有主动发送路径，仍
受 QQ 权限和额度限制。参见腾讯官方[单聊上传契约](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html)
与[群聊上传契约](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html)。
WhatsApp 使用 Baileys 7.0.0-rc14 document 字节、文件名和原引用上下文，MIME 为通用
`application/octet-stream`，不承诺原生媒体预览。参见上游[document 消息类型](https://github.com/WhiskeySockets/Baileys/blob/master/src/Types/Message.ts)。

上传成功不等于消息接受，消息接受不等于收件客户端下载。永久提供商拒绝记录在 Outbox；
Bridge 无法保证通过同一不可用渠道发出失败提示。不确定发送仍可能出现小范围重复，
不承诺 exactly-once。快照持续保留并计入额度，随 Bridge state 纳入管理员备份，
通过显式 Profile purge 删除，Archive purge 不删除快照。不引入自动清理、公共文件
服务器、预览服务或自更新器。

## 验收状态

自动测试覆盖识别、范围、符号/硬链接、防篡改、共享额度、终态事务元数据、重启重试与
两个适配器契约。macOS 上 QQ/WhatsApp 私聊及群聊真实客户端下载与原文件和 Outbox
摘要一致；两个私聊均显示非法链接拒绝提示。参见[证据与限制](acceptance/automatic-output-files.md)。
原生 Linux、Linux Docker、Windows 附件链路验收及发布/回滚门槛尚未完成；
确定性故障注入不等于真实平台故障验收。
