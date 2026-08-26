# 默认让 Observability 保持本地且不含内容

Supervisor 输出结构化 JSON Operational Log，由平台 Service Manager 收集和轮转，其中只使用内部 Correlation ID、Event Code、State、Duration、Count 以及 Version 或 Capability Fact。日志和捕获的 App Server Stderr 必须排除 Channel Body、Codex Input/Output/Reasoning、Media、Signed URL、Credential、Auth State 和原始 Provider Identity。默认没有 Telemetry 离开自托管部署；未来 OpenTelemetry Export 必须显式启用、记录 Destination、保持 Profile Isolation，并使用 Allowlisted Content-free Schema，不能隐式加入 Analytics 或 Crash Reporting。
