# Run one long-lived stdio App Server per Profile

Each Profile worker will supervise one long-lived `codex app-server` child process and communicate over its native stdio JSONL transport. That App Server manages all Codex Threads for the Profile. The first release will not expose App Server through a Bridge-owned TCP, WebSocket, or daemon listener; a network transport may be reconsidered only if a future native Codex contract requires it. This keeps the trust boundary aligned with the Profile process and avoids introducing another remotely reachable protocol surface.
