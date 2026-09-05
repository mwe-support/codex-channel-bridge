# ADR 0054: Export final-answer file links through the Outbox

Status: included in `0.2.0-rc.1` after live macOS acceptance; awaiting the other target platforms.

Codex owns file creation and the authoritative completed `agentMessage.text`;
its file-change events are not an attachment manifest. The Bridge owns external
file delivery. The user selected automatic delivery, not a `/file` command.

An opt-in Profile setting enables bounded Workspace-local Markdown link
recognition in completed final answers. Do not scan the Workspace, infer an
attachment from tool output, or add a competing Codex artifact/history model.
Snapshot validated bytes before committing attachment metadata beside text in
the existing terminal Logical Result transaction. Schema 11 adds nullable file
metadata to the Outbox; old text results preserve their digests. Apply migration
only through the existing explicit snapshot/confirmation gate.

This authorizes Workspace export to the original conversation, including its
group audience; it is not content classification or hostile-process isolation.
Provider uploads are separate from sends and recipient downloads. Preserve
receipts, retries and the possible-duplicate window. See [operator details](../output-files.md).
