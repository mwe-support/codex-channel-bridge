# Do not queue Codex input while a Profile is unavailable

When a Profile cannot use its App Server, Channel events still pass Access Policy, deduplication, and Message Archive retention, and local read-only help or status commands may remain available. Any input that would start, steer, interrupt, or queue Codex work receives an explicit unavailable response and is not placed in an outage backlog. Recovery never executes those rejected messages automatically, because durable archival records what the Channel exposed and does not imply consent to run a stale instruction later.
