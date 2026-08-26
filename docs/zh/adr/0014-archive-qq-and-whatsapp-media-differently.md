# 以不同方式归档 QQ 与 WhatsApp 媒体

QQ 媒体默认永久保存 Metadata 和 Provider Link，并可选择立即镜像；保留链接并不保证以后仍能恢复字节。Baileys 投递的 WhatsApp 媒体一旦可观察到解密后的字节，就会流式写入 SHA-256 Content-addressed Storage，因为其临时明文路径不能作为持久来源。镜像默认限制为单个附件 64 MiB、每个 Profile 10 GiB 软配额，二者均可在本地配置；超过限制时保留 Metadata，并明确标记 Bytes Unavailable。恢复和镜像必须限制流量、处理重定向并确保 URL 安全，原始文件名绝不决定存储路径，附件也绝不自动执行。部署方可以要求在 Codex 读取镜像字节前先通过外部扫描 Hook。
