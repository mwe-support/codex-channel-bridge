# 为每个 Profile 使用独立的 Codex Authentication

每个 Profile 都拥有独立的 Codex Authentication Directory 和 App Server 进程。部署者可以分别授权多个 Profile 使用同一上游订阅，但 Bridge 不会在 Profile 之间复制或静默共享 Login State，从而保留明确的凭据所有权和独立撤销能力。
