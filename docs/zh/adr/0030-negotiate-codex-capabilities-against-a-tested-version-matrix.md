# 根据受测版本矩阵协商 Codex Capability

Bridge 将声明最低 Codex CLI 版本，并发布经过 Generated-schema 和 Behavioral Contract Test 验证的明确版本矩阵；同时在每个 Profile Worker 启动时探测实际 App Server Capability，而不是根据版本号推断。缺少正确性所需的稳定 Capability 会使该 Profile 保持 Unavailable；缺少实验性 Capability 只禁用对应增强并报告 Degradation。高于受测矩阵的版本只有在所需稳定探测通过后才能运行，并且必须明显标记为 Unverified，以同时避免只支持最新版和虚假的兼容性声明。
