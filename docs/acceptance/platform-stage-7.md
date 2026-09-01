# Stage 7 platform acceptance

Date: 2026-09-01

## Native macOS

- macOS 26.6.2, Node.js 22.23.1, npm 10.9.8, and administrator-supplied Codex CLI 0.149.1.
- A real per-user launchd job started one foreground Supervisor and reached `ready`.
- The owner-only Unix control socket reported Supervisor liveness independently from Profile readiness.
- `launchctl print` exposed a 60-second exit timeout; the accepted configuration used a 45-second drain and a 5-second child-exit timeout.
- The runtime was copied outside the protected Downloads directory because a background LaunchAgent cannot rely on interactive Terminal file access.
- A real inbound and outbound QQ exchange through the signed-in desktop client returned the fixed Stage 7 marker.
- Bootout produced `ready -> draining -> stopped` and a successful Supervisor exit.

## Native Linux

- Ubuntu 24.04, kernel 6.8.0-106-generic, Node.js 22.22.1, npm 10.9.4, and administrator-supplied Codex CLI 0.149.1 on `marvel-mini-pc`.
- Fresh dependency installation, 217 unit tests, 2 platform-definition tests, 4 control-plane contracts, the Supervisor process contract, and the Codex protocol contract passed.
- A real user-systemd unit reached `ready`, exposed the local control socket, and stopped with `ready -> draining -> stopped`, exit status 0.

## Linux Docker

- Docker 29.3.0 on `marvel-mini-pc` built the production multi-stage image.
- The runtime used the non-root `node` identity, published no ports, and reported healthy over its container-local Unix socket.
- The isolated Profile reached `ready` with image-pinned Codex CLI 0.149.1 and a fresh empty Codex home.
- Docker `SIGTERM` produced `ready -> draining -> stopped`, and the container exited with status 0.

No raw provider identity, credential, message body, Codex input/output, or local sensitive path is retained in this evidence. Native Windows remains unverified until a real Windows host is designated.
