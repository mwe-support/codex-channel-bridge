import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { windowsPowerShellEnvironment } from "./windows-powershell.js";

test("native PowerShell drops foreign module paths without mutating the parent environment", () => {
  const environment = Object.freeze({ PSModulePath: "foreign", psMODULEpath: "other", PATH: "keep", PSModulePathBackup: "keep" });
  assert.deepEqual(windowsPowerShellEnvironment(environment), { PATH: "keep", PSModulePathBackup: "keep" });
  assert.equal(environment.PSModulePath, "foreign");
  assert.equal(environment.psMODULEpath, "other");
});

test("native Windows credential conversion ignores an inherited foreign Security module", { skip: process.platform !== "win32" }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-powershell-module-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const module = join(directory, "Microsoft.PowerShell.Security");
  await mkdir(module);
  await writeFile(join(module, "Microsoft.PowerShell.Security.psd1"), "@{RootModule='Security.psm1';ModuleVersion='1.0';FunctionsToExport=@('ConvertTo-SecureString')}\n");
  await writeFile(join(module, "Security.psm1"), "function ConvertTo-SecureString { throw 'synthetic_foreign_module_loaded' }\n");
  const powershell = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $secure=ConvertTo-SecureString 'synthetic-only' -AsPlainText -Force; $credential=[Management.Automation.PSCredential]::new('fixture',$secure); if($credential.Password.Length -ne 14){exit 2}; 'ok'"];
  const environment = { ...windowsPowerShellEnvironment(), PsMoDuLePaTh: directory };
  assert.throws(() => execFileSync(powershell, args, { env: environment, stdio: "pipe", timeout: 30_000, windowsHide: true }));
  const output = execFileSync(powershell, args, { env: windowsPowerShellEnvironment(environment), encoding: "utf8", timeout: 30_000, windowsHide: true });
  assert.equal(output.trim(), "ok");
});
