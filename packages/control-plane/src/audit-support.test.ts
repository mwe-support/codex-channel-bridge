import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseConfiguration } from "@codex-channel-bridge/config";
import { SqliteProfileStore } from "@codex-channel-bridge/profile-store";
import { Supervisor } from "@codex-channel-bridge/supervisor";

import { AuditManager } from "./audit-manager.js";
import { OperationsInspector } from "./operations-inspector.js";
import { SupportBundleManager } from "./support-bundle.js";

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "bridge-audit-support-"));
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
  const databasePath = join(stateDirectory, "bridge.sqlite");
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath });
  store.appendAuditRecord({
    correlationId: "correlation-old",
    action: "configuration_apply",
    result: "succeeded",
    targetReference: "revision-old",
    atMs: 1_000
  });
  store.appendAuditRecord({
    correlationId: "correlation-new",
    action: "channel_binding_change",
    result: "succeeded",
    targetReference: "binding-internal",
    atMs: 3_000
  });
  store.close();
  const supervisor = new Supervisor();
  await supervisor.apply(candidate);
  context.after(() => supervisor.stop());
  return { root, supervisor, databasePath };
}

test("queries, exports, and explicitly retains body-free Audit Records", async (context) => {
  const { root, supervisor, databasePath } = await fixture(context);
  const audits = new AuditManager(supervisor, () => 5_000);
  assert.deepEqual(audits.query({ profileId: "alpha", fromMs: 2_000 }).map((record) => record.action), [
    "channel_binding_change"
  ]);
  const destination = join(root, "audit-export.json");
  const exported = await audits.export({ profileId: "alpha", destination, limit: 10 });
  assert.equal(exported.recordCount, 2);
  if (process.platform !== "win32") assert.equal((await stat(destination)).mode & 0o777, 0o600);

  const plan = audits.planRetention("alpha", 2_000);
  assert.equal(plan.recordCount, 1);
  const result = audits.applyRetention({
    planToken: plan.planToken,
    confirmProfileId: "alpha",
    confirmRecordCount: plan.recordCount,
    confirmSelectionDigest: plan.selectionDigest
  });
  assert.equal(result.recordCount, 1);
  const store = SqliteProfileStore.open({ profileId: "alpha", databasePath, readOnly: true });
  const remaining = store.queryAuditRecords({ limit: 10 });
  assert.deepEqual(remaining.map((record) => record.action), [
    "audit_retention_cleanup",
    "channel_binding_change"
  ]);
  assert.match(remaining[0]!.targetReference, /"recordCount":1/);
  store.close();
});

test("creates a content-free owner-only Support Bundle after plan confirmation", async (context) => {
  const { root, supervisor } = await fixture(context);
  const audits = new AuditManager(supervisor, () => 6_000);
  const inspector = new OperationsInspector(supervisor, () => 6_000);
  const manager = new SupportBundleManager(supervisor, inspector, audits, () => 6_000);
  const outputPath = join(root, "support-bundle");
  const plan = await manager.plan({
    profileIds: ["alpha"],
    fromMs: 0,
    toMs: 10_000,
    outputPath
  });
  const repeatedPlan = await manager.plan({
    profileIds: ["alpha"],
    fromMs: 0,
    toMs: 10_000,
    outputPath
  });
  assert.equal(repeatedPlan.planDigest, plan.planDigest);
  assert.notEqual(repeatedPlan.planToken, plan.planToken);
  assert.equal(plan.allowlistedFields.includes("SQLite integrity and table counts"), true);
  const result = await manager.apply({
    planToken: plan.planToken,
    confirmPlanDigest: plan.planDigest
  });
  assert.equal(result.fileCount, 3);
  assert.deepEqual((await readdir(outputPath)).sort(), [
    "audit-summary.json",
    "manifest.json",
    "metadata.json"
  ]);
  for (const name of await readdir(outputPath)) {
    if (process.platform !== "win32") {
      assert.equal((await stat(join(outputPath, name))).mode & 0o777, 0o600);
    }
  }
  const all = (await Promise.all((await readdir(outputPath)).map((name) =>
    readFile(join(outputPath, name), "utf8")
  ))).join("\n");
  assert.doesNotMatch(all, new RegExp(root));
  assert.doesNotMatch(all, /correlation-old|binding-internal|secrets\.env/);
  assert.match(all, /configuration_apply/);
});
