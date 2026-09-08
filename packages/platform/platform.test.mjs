import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");

test("native Windows ACL helper reports explicit script exit codes", { skip: process.platform !== "win32" }, () => {
  const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const output = execFileSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", join(root, "windows/path-acl.contract.ps1")
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  assert.deepEqual(JSON.parse(output), { explicitExitCodes: true, serviceRegistered: false });
});

test("native Windows service errors expose a stage and numeric code without input", { skip: process.platform !== "win32" }, () => {
  const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  assert.throws(() => execFileSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", join(root, "windows/service.ps1"), "-Action", "status", "-Name", "invalid:synthetic-private-value"
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true }), error => {
    assert.equal(error.status, 1);
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /^windows_service_operation_failed_status_hresult_-?\d{1,10}\r?\n$/);
    assert.doesNotMatch(error.stderr, /synthetic-private-value/);
    return true;
  });
});

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
  assert.match(dockerfile, /^ARG CODEX_VERSION$/m);
  assert.match(dockerfile, /test -n "\$CODEX_VERSION"/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*"status"[\s\S]*control\.sock/);
  assert.doesNotMatch(dockerfile, /latest|npm update|self-update/);
});

test("Windows control pipe is owned by the ACL helper and rejects broad principals", async () => {
  const [helper, server] = await Promise.all([
    read("windows/control-pipe-server.ps1"),
    read("../control-plane/src/server.ts")
  ]);
  assert.match(server, /new WindowsPipeHost/);
  assert.match(helper, /SetAccessRuleProtection\(true, false\)/);
  assert.match(helper, /WindowsIdentity\.GetCurrent\(\)\.User/);
  assert.match(helper, /LocalSystemSid/);
  assert.match(helper, /BuiltinAdministratorsSid/);
  assert.match(helper, /VerifyAcl/);
  assert.doesNotMatch(helper, /WorldSid|AnonymousSid|Everyone/);
});

test("Windows sensitive paths use one SID-based ACL helper", async () => {
  const [helper, platform, config, secrets, store, whatsapp, output, setup] = await Promise.all([
    read("windows/path-acl.ps1"),
    read("src/windows-acl.ts"),
    read("../config/src/config.ts"),
    read("../config/src/secrets.ts"),
    read("../profile-store/src/profile-store.ts"),
    read("../whatsapp-adapter/src/baileys-auth-state.ts"),
    read("../control-plane/src/owner-only-output.ts"),
    read("../cli/src/setup.ts")
  ]);
  assert.match(helper, /S-1-5-18/);
  assert.match(helper, /S-1-5-32-544/);
  assert.match(helper, /WindowsIdentity\]::GetCurrent\(\)\.User/);
  assert.match(helper, /GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  assert.doesNotMatch(helper, /S-1-1-0|S-1-5-7|Everyone|Anonymous/);
  assert.doesNotMatch(helper, /Get-Acl|Set-Acl/);
  for (const source of [platform, config, secrets, store, whatsapp, output, setup]) {
    assert.match(source, /WindowsOwnerOnlyPath/);
  }
});
