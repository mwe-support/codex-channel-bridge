# 自动输出文件 — Next 验收

日期：2026-09-05。原生 macOS、宿主 Node.js、Codex CLI 0.149.1、腾讯 SDK
1.0.4、Baileys 7.0.0-rc14。历史实现检查点为当时基于
`4a655d34b038d33b3b53eb8af099ca0b8c03f9c6`、版本 `0.1.0-dev` 的未提交工作区。
下方源码摘要仅标识该检查点，不标识后续 tag；发布身份以该 tag 的 release notes
与门禁为准。范围与启用方法见[输出文件](../output-files.md)。

## 已授权迁移与部署

1. 通过有界 drain 与管理员清单准备 Profile 备份，无活动任务或待投递记录；
   独立 Dashboard 保持运行。
2. 管理员将 Bridge state、完整 Codex home、Workspace、配置和外部 secrets 文件
   复制到本地 owner-only 快照。逐项比较普通文件路径、权限、大小和 SHA-256；
   比较符号链接目标，不跟随链接。state 有 894 个文件，Codex home 有 1,792 个
   文件和三个符号链接；文件测试前 Workspace 为空。快照不进入 Git。
3. `bridge restore validate` 返回 valid 且无问题。迁移源摘要与快照数据库/WAL
   摘要完全一致：
   `350ba889350e48ca06349b010928d141858e44ca4f08c1c9475820231d83bbdb`。
   显式 `bridge migrate apply` 完成 schema 10→11；没有启动时自动迁移，
   没有改写 Codex 自有数据。
4. 结束备份 hold，通过配置 check/plan/确认 apply 启用
   `media.sendOutputFiles: true`，重启受影响 Profile。两个适配器均 ready。
   配置修订：`29a0f9262a8b79dd50bc4e2ede073b9b9b791198b029cbe03f5f9b99168944d7`。

迁移前快照继续保留。验证与字节比较不等于恢复/回滚演练；不能仅启动 schema-10
二进制来降级 schema 11。

## 真实客户端结果

每个成功场景均由真实桌面客户端向指定测试账号/群发送消息，经原生 Codex Turn
生成无害的工作区文本文件，并在最终回复给出本地 Markdown 链接。群聊通过客户端
原生提及选择器选中真实 Bot/Momo 条目，不使用纯文本昵称冒充提及。

| 路由 | 平台结果 | 收件下载 SHA-256 |
| --- | --- | --- |
| QQ 私聊 | 附件接受，第 1 次，23 字节 | `1b2da0bfe27a042ee9fc9f51fd55ccd42daa80b1127ef9dd24b29637d632067f` |
| WhatsApp 私聊 | 附件接受，第 1 次，23 字节 | `4aab4e6b78117f69cbb1870d447298bc9fdad23a06a014e4641903bca3cca1af` |
| QQ 群聊 | 附件接受，第 1 次，29 字节 | `9260e6d2402cf0e76811190bca7470deb30443eb15d3b6a73f1ea2537bf2d1b3` |
| WhatsApp 群聊 | 附件接受，第 1 次，29 字节 | `6f9589dd6b0eed606e47ab8f8f2b6cc988f278df4bb0661e1028268e00629d84` |

四个下载均与原文件及已提交 Outbox 快照一致。这验证传输保持字节，不代表模型
遵守了每条文件格式指令。QQ 使用下载/另存为；WhatsApp 使用保存到下载。仅打开
文档预览不计为下载证据。WhatsApp 将最终链接显示为普通文本，同时提供可用的
document 卡片；不承诺原生 Markdown 链接渲染。

两个私聊中的不存在文件与父目录链接都产生可见的附件拒绝提示，没有文件 Outbox 行。
另一个要求等待 45 秒的 WhatsApp 任务正常投递文件；这不是断开适配器或发送结果
不确定的测试。宿主 disconnect 操作要求账号空闲，未绕过这一保护。

随后正常停止 Supervisor，依次报告 draining、stopped，进程以 0 退出；使用原配置
重启后两个适配器均恢复 ready。重启前后均为 50 个终态输入、65 条 accepted Outbox、
五条文件记录（QQ 两条、WhatsApp 三条），文件尝试次数均保持 1，SQLite
`quick_check=ok`。本次观察中没有重新入队已接受附件。Dashboard 监听器保持可用；
受保护页面不通过根 URL 提供。

## 自动检查与准确限制

- `npm test`：macOS 上 250 项单元、4 项发布工具、4 项平台契约检查全部通过。
  文件检查覆盖范围/排除项、符号/硬链接、原文件变更、快照篡改、大小/共享额度、
  结果元数据原子提交与冲突检测。真实 SQLite 关闭/重开及租约过期后，文件元数据、
  Logical Result、记录和回复序列保持不变。
- 适配器故障注入覆盖 QQ 上传拒绝/限流/不确定、上传失败不发送、发送不确定及
  重试时重新上传；WhatsApp 上传/发送合并步骤失败及缺失回执保持 ambiguous。
  Outbox 测试覆盖重试身份、适配器不可用和快照缺失。
  这些是确定性测试，不是故意制造真实平台故障。
- 宿主 `npm run test:contract` 通过；Codex schema SHA-256：
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`。
- 双语更新的 `npm run docs:build` 与 `git diff --check` 均通过。

该新附件链路的原生 Linux、Linux Docker、Windows 验收仍未验证。不声称已实测
平台限流、回复窗口过期、断电或不确定发送的重复窗口。既有发布与回滚门槛继续有效；
FR-010 在已验证范围之外仍待验收。

运行时源码标识（不是完整构建产物摘要）：

| 源文件 | SHA-256 |
| --- | --- |
| `profile-worker/src/output-files.ts` | `b797fcfc61ae490bb2e4a2be4cf9a867def0a14b7a5e4d7a532ce6be89a9205e` |
| `profile-worker/src/delivery-outbox.ts` | `06933cce8daabf5a960870c5936fb4e1375b53f1e6546bcf0548da7272c13c45` |
| `qq-adapter/src/qq-adapter.ts` | `2000101c7773d28ffb3d0e53fdb0873fb1d021ce30a00d424d588eed59aad5ab` |
| `whatsapp-adapter/src/whatsapp-adapter.ts` | `deb0260b3ac4c88d587e469fac46fd084dd1a159446510d8ba61f2075c054221` |

本记录不保留消息/文件正文、原始提供商身份、凭证、签名 URL 或配对材料。
