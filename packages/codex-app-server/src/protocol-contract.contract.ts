import assert from "node:assert/strict";

import { BRIDGE_VERSION } from "@codex-channel-bridge/core";

import { CodexAppServerProcess } from "./app-server-process.js";
import {
  probeCodexProtocol
} from "./protocol-schema.js";

const executable = process.env.CODEX_EXECUTABLE ?? "codex";
const probe = await probeCodexProtocol(executable);

const server = new CodexAppServerProcess({
  executable,
  codexHome: process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`,
  workspace: process.cwd(),
  bridgeVersion: BRIDGE_VERSION,
  experimentalApi: probe.optionalMethods.length > 0
});

try {
  const initialized = await server.start();
  assert.equal(typeof initialized.userAgent, "string");
  assert.equal(typeof initialized.codexHome, "string");
  const models = await server.request<{ data: readonly unknown[] }>("model/list", {});
  assert.ok(Array.isArray(models.data));
  process.stdout.write(
    `${JSON.stringify({ ok: true, codexVersion: probe.cliVersion, schemaSha256: probe.schemaSha256, verification: probe.verification, optionalMethods: probe.optionalMethods })}\n`
  );
} finally {
  await server.stop();
}
