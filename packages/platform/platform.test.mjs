import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");

test("platform services run one foreground Supervisor with bounded stop semantics", async () => {
  const [launchd, systemd] = await Promise.all([
    read("macos/org.codex-channel-bridge.supervisor.plist"),
    read("linux/codex-channel-bridge.service")
  ]);
  for (const definition of [launchd, systemd]) {
    assert.match(definition, /supervisor/);
    assert.match(definition, /run/);
    assert.doesNotMatch(definition, /--daemon|PIDFile|Type=forking/);
  }
  assert.match(launchd, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(launchd, /<key>ExitTimeOut<\/key>\s*<integer>60<\/integer>/);
  assert.match(systemd, /^KillMode=mixed$/m);
  assert.match(systemd, /^TimeoutStopSec=320$/m);
  assert.match(systemd, /^RuntimeDirectoryMode=0700$/m);
});

test("Docker image is non-root, pinned, signal-aware, and checks Supervisor liveness", async () => {
  const dockerfile = await read("docker/Dockerfile");
  assert.match(dockerfile, /^FROM node:22\.23\.1-bookworm AS build$/m);
  assert.match(dockerfile, /^FROM node:22\.23\.1-bookworm-slim AS runtime$/m);
  assert.match(dockerfile, /^ARG CODEX_VERSION=0\.149\.1$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*"status"[\s\S]*control\.sock/);
  assert.doesNotMatch(dockerfile, /latest|npm update|self-update/);
});
