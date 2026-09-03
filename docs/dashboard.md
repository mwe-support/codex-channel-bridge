---
title: Local dashboard
---

# Local dashboard

The optional Dashboard shows the running Bridge version, host liveness,
configuration revision, Profile readiness, and per-account QQ or WhatsApp
connectivity. It also exposes the existing configuration plan/apply workflow.

Start it against the owner-only local control socket:

```sh
bridge dashboard --endpoint /absolute/path/control.sock
```

The command binds an ephemeral port on `127.0.0.1` and prints a random,
launch-scoped URL. Open that URL on the same host. Treat it as an administrator
capability: do not share it or copy it into logs. Press Ctrl-C to stop the
Dashboard and invalidate the URL. LAN, public, unattended, and multi-user
access are not supported.

## Settings

Enter the absolute path to an existing `config.yaml`, select **Plan**, and
review the redacted result. **Apply** is enabled only after a successful plan
and requires the complete candidate revision. The Dashboard sends both actions
through the same host-local control plane used by `bridge config plan` and
`bridge config apply`; it never writes Profile databases, workers, secrets, or
configuration files directly.

## Operational events

Recent events are a bounded, content-free record of status changes and
Dashboard operations observed since this Dashboard process started. They are
not a replacement for launchd, journald, Windows Service, or Docker logs. The
Dashboard does not read Channel message bodies, Codex content, the Message
Archive, Codex home, or Workspace files.

`bridge status` exposes the same authoritative `bridgeVersion` field when a
browser is not needed.
