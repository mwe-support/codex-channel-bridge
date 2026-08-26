# 显式并事务性地应用配置

首版不监视 `config.yaml` 进行自动重载：System Administrator 使用 `bridge config check` 和显式确认的 `bridge config apply`，后者重新读取 Environment Override、验证完整 Candidate，并在存在任何静态错误时拒绝它且不改变当前 Configuration Revision。Apply Plan 显示脱敏 Diff、受影响的 Profile 以及所需 Drain/Restart Action，但不泄露 Secret Value。配置一经接受，各 Profile 独立 Transition；Workspace、Codex home、Channel Account 或 App Server Environment 变更需要对该 Profile 进行有界 Drain 和 Restart；运行时失败只让该 Profile Unavailable，不回滚或干扰健康的 Sibling。
