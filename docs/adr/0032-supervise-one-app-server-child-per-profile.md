# Supervise one App Server child per Profile

Each Profile worker will start and supervise one exclusive Codex App Server child using the administrator-supplied Codex executable. The first release will not connect multiple Profiles to a shared App Server or attach to an administrator-run remote App Server, because doing so would weaken the alignment between Profile ownership, Codex home, Workspace, authentication, capability negotiation, failure recovery, and process lifecycle. Failure of one Profile's child remains isolated from other Profile workers.
