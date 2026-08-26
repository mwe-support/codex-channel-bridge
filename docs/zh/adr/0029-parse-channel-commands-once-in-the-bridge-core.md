# 在 Bridge Core 中统一解析一次 Channel Command

Channel Adapter 将规范化后的文本转发给一个 Bridge Command Parser。只有与消息开头准确匹配的已注册命令才会执行；`//text` 转义为普通 Codex Input，未知 Slash Command 返回错误和 `/help`，而不是创建 Turn。Provider 原生命令菜单只是可选快捷方式，不能改变命令名称、参数规则或授权语义。这使 QQ 和 WhatsApp 的控制语义保持等价，并防止 Adapter 自行解析命令而绕过 Profile Capability。
