import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  applyConfigurationEdit, formatConfiguration, loadConfiguration,
  planConfigurationEdit, SecretResolver
} from "@codex-channel-bridge/config";
import { secureWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("./main.js", import.meta.url));
const cli = (...args: string[]) => execute(process.execPath, [entry, ...args], {
  env: { ...process.env, BRIDGE_CONFIG_OVERRIDES_JSON: undefined }, timeout: 15_000
});

test("terminal configuration and secret commands validate, confirm, preserve state, and avoid secret output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-cli-settings-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  secureWindowsOwnerOnlyPath(root, "directory");
  for (const name of ["workspace", "codex", "state"]) {
    await mkdir(join(root, name), { mode: 0o700 });
    secureWindowsOwnerOnlyPath(join(root, name), "directory");
  }
  const path = join(root, "config.yaml");
  const text = formatConfiguration({ schemaVersion: 1, profiles: { primary: {
    workspace: join(root, "workspace"), codexHome: join(root, "codex"), stateDirectory: join(root, "state"),
    channelAccounts: { "qq-primary": { provider: "qq", epochId: "initial", appId: "env:APP_ID", appSecret: "env:APP_SECRET" } }
  } } });
  await writeFile(path, text, { mode: 0o600 });
  secureWindowsOwnerOnlyPath(path, "file");
  assert.match((await cli("--help")).stdout, /bridge secret set/);
  assert.match((await cli("config", "--help")).stdout, /bridge config set/);
  const command = ["config", "set", "--config", path, "--key", "profiles.primary.media.sendOutputFiles", "--value-json", "true"];
  const preview = JSON.parse((await cli(...command)).stdout);
  assert.equal(preview.saved, false);
  assert.equal(await readFile(path, "utf8"), text);
  await assert.rejects(cli(...command, "--confirm", "wrong"));
  assert.equal(await readFile(path, "utf8"), text);
  await cli(...command, "--confirm", preview.confirmationRequired);
  assert.equal((await loadConfiguration(path)).configuration.profiles.primary?.media.sendOutputFiles, true);
  const saved = await readFile(path, "utf8");
  await assert.rejects(cli("config", "set", "--config", path, "--key", "profiles.primary.media.profileQuotaBytes", "--value-json", "0"));
  await assert.rejects(cli("config", "set", "--config", path, "--key", "profiles.__proto__.enabled", "--value-json", "false"));
  assert.equal(await readFile(path, "utf8"), saved);
  const stale = await planConfigurationEdit(path, { key: "profiles.primary.enabled", value: false });
  await writeFile(path, saved + "\n# another writer\n");
  await assert.rejects(applyConfigurationEdit(stale, stale.planDigest), /changed/);
  assert.equal((await loadConfiguration(path)).configuration.profiles.primary?.enabled, true);
  assert.equal(JSON.parse((await cli("channel", "list", "--config", path, "--profile", "primary")).stdout)[0].provider, "qq");
  await assert.rejects(cli("channel", "list", "--config", path, "--profile", "missing"));
  const secretInput = join(root, "input");
  const marker = "synthetic-cli-secret-$()'\"-literal";
  await writeFile(secretInput, marker, { mode: 0o600 });
  secureWindowsOwnerOnlyPath(secretInput, "file");
  const result = await cli("secret", "set", "--config", path, "--profile", "primary", "--name", "APP_SECRET", "--from-file", secretInput);
  assert.ok(!result.stdout.includes(marker));
  assert.ok(!result.stdout.includes("APP_SECRET"));
  assert.equal(await (await SecretResolver.open({ secretsFile: join(root, "state", "secrets.env"), environment: {} })).resolve("env:APP_SECRET"), marker);
  await assert.rejects(cli("secret", "set", "--config", path, "--profile", "primary", "--name", "APP_SECRET", "--value", "forbidden"));
  await assert.rejects(cli("secret", "set", "--config", path, "--profile", "primary", "--name", "APP_SECRET"));
});

test("native service startup waits for the parent handshake and exits if the parent stops", async () => {
  const missingConfig = join(tmpdir(), "bridge-service-handshake-missing", "config.yaml");
  const result = await new Promise<{ code: number; stderr: string }>(resolve => {
    const child = execFile(process.execPath, [entry, "supervisor", "run", "--config", missingConfig, "--service-stdin", "yes"],
      { timeout: 5000 }, (error, _stdout, stderr) => resolve({ code: Number(error?.code ?? 0), stderr }));
    child.stdin!.end("stop\n");
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Service parent stopped before startup/);
  assert.doesNotMatch(result.stderr, /config path|regular file/);
});
