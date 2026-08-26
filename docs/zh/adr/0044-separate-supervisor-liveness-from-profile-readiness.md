# 分离 Supervisor Liveness 与 Profile Readiness

Bridge 分别暴露 Supervisor Liveness 和每个 Profile 的 Readiness，因此一个 Unavailable Profile 不会导致平台 Service Manager 或 Docker 重启健康的 Sibling。默认平台 Health Check 只覆盖 Main Process、Control Plane 和 Event Loop；Profile Check 则以稳定 Reason Code 报告 `starting`、`ready`、`degraded`、`unavailable`、`draining` 或 `stopped`。管理和部署 Gate 可以指定某个 Profile，或明确要求所有 Profile 均为 Ready。只有致命的 Supervisor、Configuration-loading 或 Control-plane 故障才会使整个服务变为 Unhealthy。
