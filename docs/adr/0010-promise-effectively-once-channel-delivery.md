# Promise effectively-once Channel delivery

The Bridge will target effectively-once processing and final delivery using provider event identities, Codex input correlation, a durable outbox, Logical Result identities, segment identities, and restart reconciliation. If a provider may have accepted a send but exposes neither an idempotency key nor a way to reconcile it, the Bridge favors delivery and retries the same Logical Result, accepting a small visible duplicate window rather than silently losing a terminal result. It will not claim strict exactly-once behavior.
