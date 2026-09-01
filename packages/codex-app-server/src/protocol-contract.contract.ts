import assert from "node:assert/strict";

import { BRIDGE_VERSION } from "@codex-channel-bridge/core";

import { CodexAppServerProcess } from "./app-server-process.js";
import {
  PINNED_CODEX_VERSION,
  PINNED_STABLE_SCHEMA_SHA256,
  OPTIONAL_EXPERIMENTAL_METHODS,
  probeCodexProtocol
} from "./protocol-schema.js";

const executable = process.env.CODEX_EXECUTABLE ?? "codex";
const probe = await probeCodexProtocol(executable);
assert.equal(probe.cliVersion, PINNED_CODEX_VERSION);
assert.equal(probe.schemaSha256, PINNED_STABLE_SCHEMA_SHA256);
assert.equal(probe.verification, "tested");
assert.deepEqual(probe.experimentalMethods, OPTIONAL_EXPERIMENTAL_METHODS);

const server = new CodexAppServerProcess({
  executable,
  codexHome: process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`,
  workspace: process.cwd(),
  bridgeVersion: BRIDGE_VERSION,
  experimentalApi: true
});

try {
  const initialized = await server.start();
  assert.equal(typeof initialized.userAgent, "string");
  assert.equal(typeof initialized.codexHome, "string");
  const models = await server.request<unknown>("model/list", {});
  assert.equal(typeof models, "object");
  process.stdout.write(
    `${JSON.stringify({ ok: true, codexVersion: probe.cliVersion, schemaSha256: probe.schemaSha256 })}\n`
  );
} finally {
  await server.stop();
}
