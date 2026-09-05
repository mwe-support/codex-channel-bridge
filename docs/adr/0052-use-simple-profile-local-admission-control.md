# Use simple Profile-local Admission Control

Next amendment, accepted 2026-09-05: keep one bounded queue with FIFO within
each Thread Binding. Start the oldest eligible entry, skipping work blocked by
its active Thread, so independent work can use free capacity. Retain queue age,
capacity, initiator checks, account rates, no outage backlog and bounded drain.
Co-locate active Channel context and Turn target; verify consistent controller
lookup and account counts through promotion, drain and release.

Profiles execute independently without a central work scheduler. Reuse the
Outbox with independent claims and sends per Channel Account. Account-scoped
claims must not reclaim another account's live leases. Preserve Logical Result
segment order and durable retries. Adapters interpret provider errors/hints;
Outbox persists retry times with bounded backoff. Verify blocked sends, batches
filled by one account, later arrivals, ordering, restart and drain. This
supersedes the original global FIFO, cross-Profile round-robin and retry-location
wording below, without introducing an external broker or general scheduler.

`0.2.0-rc.1` amendment, accepted 2026-09-04 (FR-003): independent Threads have no default
Bridge concurrency cap. `maximumActiveTurns: null` selects unlimited admission;
an explicit finite cap remains operator-controlled. This supersedes the mandatory
cap in the original decision below, not same-Thread steer/queue, rate limits,
disk protection or access checks. No additional scheduler or gateway is introduced.

The first release will bound each Profile with a maximum active-Turn count, one size-and-age-limited FIFO used only by explicit queue mode while ready, and a simple per-Channel-Account admission rate. A full queue rejects the newest input as `busy`, an expired entry is reported and never executed, and steer mode creates no ordinary queue; fixed priority serves Approval or user-input responses, committed outbox delivery, active-Turn control, then new Turns, with a round-robin Profile scan. Provider backoff remains adapter-local, and storage pressure first rejects new work and media mirroring, then disconnects affected adapters with `unavailable: storage_pressure` before unsafe archival. This deliberately avoids a general scheduler, broker, distributed or hierarchical quotas, and built-in CPU or memory isolation; hard resource security remains a deployment responsibility.
