# Automatic output attachments

Status: included in prerelease `0.2.0-rc.1`, with cross-platform acceptance still
open (FR-010). Existing databases need the
[explicit schema 11 migration](migrations.md) before deployment.

## Enable and use

Merge `media.sendOutputFiles: true` into the selected Profile in `config.yaml`,
then run `bridge config check` and the confirmed `bridge config apply` workflow.
This change drains/restarts that Profile. The default is `false`; quick setup
keeps it off, while full setup exposes the choice. Disabling it stops preparing
new attachments, but does not cancel previously committed Outbox deliveries.

Ask Codex to create the output in its Workspace and include a Markdown download
link in its final answer, for example `[Report](output/report.pdf)` or
`[Report](</absolute/workspace/output/report with spaces.pdf>)`. The Bridge
automatically snapshots and attaches the file to the **originating conversation**;
no `/file` command or separate confirmation is required. In a group, all group
members able to read the conversation may receive the file.

This is an export permission for that Profile's Workspace, not proof that a file
was newly created or that its contents are non-sensitive. Enable it only for
Workspaces appropriate for the configured participants. Shared-OS-user isolation
does not defend against a hostile local process modifying the Workspace.

## Recognition and bounds

- Only local inline Markdown links/images from completed final answers are
  considered. Plain paths, reference links, code fences, indented code, lines
  containing inline backticks, quoted lines, escaped links and HTML code blocks
  do not trigger export. Web URLs and links with query/fragment suffixes are
  ignored. There is no Workspace scan or extraction from tool/file-change events.
- At most three distinct link targets per answer are considered. Relative paths
  resolve against the Profile Workspace, not a tool's temporary working directory.
- Files must be nonempty regular files inside that Workspace, with no symlink
  components or hard links. Hidden paths, common secret/auth/env/key names,
  Codex home, Bridge state and configured secret files are excluded. This is not
  content inspection or a general secret-detection system.
- The effective per-file limit is the smaller of `perAttachmentLimitBytes` and
  64 MiB. Snapshots share `profileQuotaBytes` with mirrored inbound media and
  respect the deployment disk floor. Writes are serialized with inbound media.
  Insufficient space rejects attachment preparation, retaining the text answer
  with an explicit notice. Admission conservatively reserves the full file size,
  even when its content may already be stored.

## Persistence and provider semantics

Snapshots live in the Profile's `stateDirectory/outbound-files/`, named by SHA-256
and stored owner-only. The snapshot is flushed before terminal text and file
metadata are committed in the **same Logical Result / Outbox transaction**.
Retry reads and verifies those bytes, never the original mutable Workspace path.
Changing or deleting the original file therefore does not change a committed
attachment. Missing or corrupted snapshots fail closed. Existing ordering,
epoch validation, receipts, backoff and ambiguous-send handling still apply.

QQ SDK 1.0.4 uploads with `srvSendMsg: false`, then sends `msg_type: 7` using the
durably allocated reply sequence. Retries upload again rather than caching an
expired `file_info`; an explicitly expired reply anchor attempts the existing
proactive-send path, which remains subject to QQ permissions and quotas.
See Tencent's [private upload contract](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html)
and [group upload contract](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html).
WhatsApp uses Baileys 7.0.0-rc14 document bytes, filename and original quote context,
with generic `application/octet-stream`; native inline media previews are not
promised. See the upstream [document message type](https://github.com/WhiskeySockets/Baileys/blob/master/src/Types/Message.ts).

Upload success is not message acceptance; message acceptance is not recipient
download. Permanent provider rejection is recorded in the Outbox; the Bridge
cannot guarantee that a failure notice can traverse the same unavailable channel.
Ambiguous sends retain the existing possible-duplicate window, not exactly-once
semantics. Snapshots are retained, charged to quota, included with Bridge state
in operator backups, and removed by explicit Profile purge—not Archive purge.
No automatic cleanup, public file server, preview service or self-updater is added.

## Acceptance status

Automated checks cover recognition, scope, symlinks/hard links, tampering, shared
quota, terminal transaction metadata, restart retry and both adapter contracts.
Real macOS QQ and WhatsApp private/group recipient downloads match the source
and Outbox digests. Both private chats show rejection notices for invalid links.
See [evidence and limits](acceptance/automatic-output-files.md). Native Linux,
Linux Docker and Windows attachment-path acceptance and release/rollback gates
remain open; deterministic fault injection is not a live provider outage claim.
