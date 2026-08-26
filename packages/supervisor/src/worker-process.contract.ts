import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseConfiguration } from "@codex-channel-bridge/config";

import { Supervisor } from "./supervisor.js";

const workspace = resolve(process.env.BRIDGE_CONTRACT_WORKSPACE ?? process.cwd());
const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const executableLine = process.env.CODEX_EXECUTABLE
  ? `\n    codexExecutable: ${JSON.stringify(process.env.CODEX_EXECUTABLE)}`
  : "";
const brokenRoot = await mkdtemp(join(tmpdir(), "bridge-broken-profile-"));
const contractRoot = await mkdtemp(join(tmpdir(), "bridge-contract-profile-"));
const brokenWorkspace = join(brokenRoot, "workspace");
const brokenCodexHome = join(brokenRoot, "codex-home");
const brokenState = join(brokenRoot, "state");
const contractState = join(contractRoot, "state");
await Promise.all([
  mkdir(brokenWorkspace),
  mkdir(brokenCodexHome),
  mkdir(brokenState, { mode: 0o700 }),
  mkdir(contractState, { mode: 0o700 })
]);
const candidate = parseConfiguration(`
schemaVersion: 1
supervisor:
  drainTimeoutMs: 10000
  childExitTimeoutMs: 5000
profiles:
  broken:
    workspace: ${JSON.stringify(brokenWorkspace)}
    codexHome: ${JSON.stringify(brokenCodexHome)}
    stateDirectory: ${JSON.stringify(brokenState)}
    codexExecutable: ${JSON.stringify(join(brokenRoot, "missing-codex"))}
  contract:
    workspace: ${JSON.stringify(workspace)}
    codexHome: ${JSON.stringify(codexHome)}
    stateDirectory: ${JSON.stringify(contractState)}${executableLine}
`);

const supervisor = new Supervisor();
try {
  const result = await supervisor.apply(candidate);
  const profile = result.profiles.find((value) => value.profileId === "contract");
  const broken = result.profiles.find((value) => value.profileId === "broken");
  assert.equal(profile?.readiness, "ready", `Profile failed to start: ${profile?.reason}`);
  assert.equal(broken?.readiness, "unavailable");
  assert.equal(broken?.reason, "codex_not_found");
  assert.equal(supervisor.status().liveness, "live");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      revision: result.acceptedRevision,
      profiles: result.profiles.map((value) => ({
        profileId: value.profileId,
        readiness: value.readiness,
        reason: value.reason
      }))
    })}\n`
  );
} finally {
  await supervisor.stop();
  await Promise.all([
    rm(brokenRoot, { force: true, recursive: true }),
    rm(contractRoot, { force: true, recursive: true })
  ]);
}
