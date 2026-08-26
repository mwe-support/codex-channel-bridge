# Isolate Profiles with separate workers under one OS user

To reduce cross-platform administration complexity, each Profile will use a separate worker, Codex App Server process, Codex home, and Workspace while Bridge processes share one OS user. This is application-layer isolation: the host administrator and deployed code are trusted, and the project will not claim protection from a malicious same-user process or sandbox escape; deployments that require hostile-process isolation must add an OS-user or container boundary outside this default profile model.
