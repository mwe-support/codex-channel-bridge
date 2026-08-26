# 保持 Codex 安装与升级由 Operator 所有

Bridge 把主机 Codex CLI 视为管理员提供的外部依赖，绝不通过原生安装程序或运行中的服务安装、升级、降级或修复它。原生部署接受显式 Executable Path 或 Service Environment；当 Codex 缺失或不兼容时，受影响的 Profile 必须失败关闭并提供可操作的诊断。Linux Docker Image 可以在构建阶段固定一个受测 Codex CLI，但运行中的容器绝不自行更新；更改版本必须构建或拉取新 Image。
