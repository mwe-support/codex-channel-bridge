# 在一个 Bridge 中承载互不信任的 Profile

一个 Codex Channel Bridge 部署将承载多个属于互不信任用户或部门的 Profile，借鉴单个 Hermes Gateway 多 Profile 的有效隔离形态，但不保留 Hermes 依赖。每个 Profile 拥有各自的 QQ 和 WhatsApp Channel Binding，并且是应用层安全边界，而非仅用于展示的标签；所选的共享 OS 用户进程模型本身不提供针对恶意进程的隔离。
