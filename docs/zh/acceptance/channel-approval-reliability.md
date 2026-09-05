# QQ 与 WhatsApp 审批可靠性 — Next

- 日期：2026-09-05，原生 macOS；Codex CLI 0.149.1。
- 历史实现检查点：当时基于 `4a655d34b038d33b3b53eb8af099ca0b8c03f9c6`
  的未提交工作区。下方源码摘要仅标识该检查点，不标识后续候选发布树；发布身份
  以该 tag 的 release notes 与门禁为准。
- 最终源码 SHA-256：
  - `codex-server-request-router.ts`：
    `a5c61b4a976aef7336da411acaef032851a15187e318d97b4df57898d519364d`
  - `profile-worker.ts`：
    `7a872ce2a3bcf09b15a41c55d8434199093c65d4a8ed9194543eed93c848cb73`

## 行为变更

将原生 `serverRequest/resolved` 和 Turn 终态通知投射为 TOKEN 失效、取消未发出的
持久提示。写回响应失败期间若连接代际已关闭，不再恢复旧 TOKEN。成功响应后尝试
发送简短确认；非法、重复、过期或上下文不匹配时尝试发送相同的不泄露详情的拒绝
提示。确认文字不代表原生操作已执行成功。

已核对[官方 App Server 审批契约](https://learn.chatgpt.com/docs/app-server#approvals)、
0.149.1 生成的命令/文件审批及 ServerRequestResolved Schema，以及固定版本的
[上游请求取消实现](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/app-server/src/outgoing_message.rs)。
没有引入 Bridge Reviewer 策略，也没有修改 Codex 安装。

## 真实客户端验收

现有 Profile 的原生 `auto_review` 在两个私聊中完成了无害 `pwd` 探针，没有待处理
渠道审批；这不计为人工审批通过。使用管理员提供的临时可执行包装脚本，为测试
进程选择原生 `user` reviewer；新建测试 Thread，避免覆盖恢复 Thread 的设置。

| 场景 | QQ 私聊 | WhatsApp 私聊 |
| --- | --- | --- |
| 真实命令审批提示 | 客户端可见，平台接受 | 客户端可见，平台接受 |
| 原生决定 | `accept`，持久状态 `responded` | `decline`，持久状态 `responded` |
| 重复决定 | 拒绝，不产生第二次原生响应 | 拒绝，不产生第二次原生响应 |
| 待审批时 `/stop` | `cancelled / codex_request_resolved` | `cancelled / codex_request_resolved` |
| 响应超时（测试设为 30 秒） | `expired / response_timeout` | `expired / response_timeout` |
| 回答已取消/过期 TOKEN | 拒绝 | 拒绝 |

将 WhatsApp TOKEN 发到 QQ 后被拒绝，没有解决任何待审批请求。共保留六条真实
审批：两条 responded（一次接受、一次拒绝）、两条原生取消、两条超时；六条提示
均获得平台接受回执。客户端检查区分了屏外/辅助功能文本缺失和实际未送达，
其中 WhatsApp 超时提示通过截图核验。

恢复配置并重启最终候选后，在两个客户端提交旧 TOKEN，未产生新原生工作。
两个私聊原 Thread 绑定、原生 `auto_review` 默认值和五分钟超时均已恢复，群聊
绑定未变。Supervisor 与两个 Adapter 均为 ready，43 条既有/测试输入关联均终结，
独立 Dashboard 监听仍可用。临时 reviewer 选择没有写入宿主 Codex 配置。

## 自动检查与限制

- `npm test`：241 项单元、4 项发布工具、4 项平台契约测试全部通过。相关检查
  覆盖错误 Profile/账号/Epoch/会话/参与者、带类型请求 ID、原生取消、重复/过期
  TOKEN、代际关闭时写失败、Outbox 重试和 Worker 重启。
- 宿主 `npm run test:contract` 通过，Schema SHA-256：
  `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`。
  首次工具沙箱内运行因 App Server stdout 关闭失败，未当作成功原生检查。
- 中英文文档构建及 `git diff --check` 通过。

本轮不承诺真实群聊审批、真实文件修改审批、全部 Codex 请求类型，也不保证越过
QQ 平台回复权限投递。故障注入与重试检查是补充，不替代上述真实私聊命令审批。
既有发布门槛继续有效。

## 输出文件预检，不是文件投递验收

通过腾讯 SDK 1.0.4，向配置的私聊测试收件人上传无害生成文本字节，类型为通用
文件，并关闭自动发送。QQ 返回有效文件引用与 86,400 秒 TTL；没有启动第二个
Gateway。这只证明上传能力，不证明消息接受、收件客户端下载、文件持久重试或
WhatsApp 文件投递。面向用户的文件发送授权入口仍待确定。

本记录不保留凭证、TOKEN、原始提供商标识、消息正文、命令输出、文件引用、
签名 URL 或认证材料。
