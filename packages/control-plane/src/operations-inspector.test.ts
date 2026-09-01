import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseConfiguration } from "@codex-channel-bridge/config";
import { SqliteProfileStore } from "@codex-channel-bridge/profile-store";

import { OperationsInspector } from "./operations-inspector.js";

test("inspects one Profile without mutating its runtime or database", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-doctor-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const stateDirectory = join(root, "state");
  for (const path of [workspace, codexHome, stateDirectory]) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  const candidate = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    enabled: false
    workspace: ${workspace}
    codexHome: ${codexHome}
    stateDirectory: ${stateDirectory}
`);
  SqliteProfileStore.open({
    profileId: "alpha",
    databasePath: join(stateDirectory, "bridge.sqlite")
  }).close();
  const profile = candidate.configuration.profiles.alpha!;
  let statusReads = 0;
  let configurationReads = 0;
  const inspector = new OperationsInspector({
    status: () => {
      statusReads += 1;
      return {
        liveness: "live",
        configurationRevision: candidate.revision,
        profiles: [{ profileId: "alpha", readiness: "stopped", reason: null }]
      };
    },
    profileConfiguration: (profileId) => {
      configurationReads += 1;
      return profileId === "alpha" ? profile : undefined;
    }
  }, () => 12_345);

  const result = await inspector.inspect(["alpha"]);

  assert.equal(result.ok, true);
  assert.equal(result.inspectedAtMs, 12_345);
  assert.equal(result.profiles[0]?.store?.quickCheck, "ok");
  assert.equal(result.profiles[0]?.store?.schemaVersion, 9);
  assert.equal(result.profiles[0]?.paths.stateDirectory.ownerOnly, true);
  assert.equal(result.profiles[0]?.disk?.availableBytes! > 0, true);
  assert.deepEqual(result.profiles[0]?.issues, []);
  assert.equal(statusReads, 1);
  assert.equal(configurationReads, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(root));
});

test("reports read-only path and store issues without throwing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-doctor-bad-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(stateDirectory, { mode: 0o755 });
  await chmod(stateDirectory, 0o755);
  const candidate = parseConfiguration(`
schemaVersion: 1
profiles:
  alpha:
    workspace: ${workspace}
    codexHome: ${join(root, "missing-codex-home")}
    stateDirectory: ${stateDirectory}
`);
  const profile = candidate.configuration.profiles.alpha!;
  const result = await new OperationsInspector({
    status: () => ({
      liveness: "live",
      configurationRevision: candidate.revision,
      profiles: [{ profileId: "alpha", readiness: "unavailable", reason: "profile_store_unavailable" }]
    }),
    profileConfiguration: () => profile
  }).inspect();

  assert.equal(result.ok, false);
  assert.deepEqual(result.profiles[0]?.issues, [
    "codex_home_invalid",
    "profile_store_unavailable",
    "state_directory_insecure"
  ]);
});
