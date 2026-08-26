# 在同一 OS 用户下使用独立 Worker 隔离 Profile

为了降低跨平台管理复杂度，每个 Profile 都使用独立的 Worker、Codex App Server 进程、Codex home 和 Workspace，而 Bridge 进程共享一个 OS 用户。这属于应用层隔离：主机管理员和已部署代码均被信任，本项目不会宣称能够抵御同一用户下的恶意进程或沙箱逃逸；需要针对恶意进程进行隔离的部署，必须在默认 Profile 模型之外增加 OS 用户或容器边界。
