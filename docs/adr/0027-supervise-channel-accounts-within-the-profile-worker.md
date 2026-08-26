# Supervise Channel Accounts within the Profile worker

Each Channel Account runs as an independently supervised adapter instance with its own connection state, retry backoff, rate-limit state, and health status. Failure of one instance does not stop the Profile's other adapters or App Server. The first release keeps those instances inside the Profile worker, so the promised process-failure boundary remains the Profile; an SDK that demonstrates process-level instability may be moved behind a child-process boundary without forcing every adapter into that deployment shape.
