# 支持四种一等部署目标

首个公开版本将支持原生 macOS、原生 Linux、原生 Windows 和 Linux Docker 部署，而不是把非 macOS 环境视为尽力支持的移植版本。各平台的服务管理方式可以不同，但 Bridge Domain、Profile 行为、Channel Contract、持久化保证和核心验收测试在四种目标上必须保持等价。当前实现与验收优先处理可验证环境，顺序为：先在本地开发机器验证原生 macOS，再通过 SSH 别名 `marvel-mini-pc` 指向的远程主机验证原生 Linux 和 Linux Docker。Windows 仍是首版目标，但要等这三个环境完成并指定真实 Windows 验证主机后再继续；在其他操作系统上的模拟结果不能作为验收证据。
