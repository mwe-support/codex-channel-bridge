import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("the POSIX installer verifies and atomically switches exact releases", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX installer acceptance runs on macOS and Linux");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "bridge-installer-test-"));
  const assets = join(root, "assets");
  const fakeBin = join(root, "bin-tools");
  const installRoot = join(root, "install");
  const commandBin = join(root, "commands");
  await mkdir(assets);
  await mkdir(fakeBin);

  await executable(join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n");
  await executable(join(fakeBin, "npm"), `#!/bin/sh
set -eu
if [ "$1" = ci ]; then exit 0; fi
if [ "$1" = run ] && [ "$2" = build ]; then
  mkdir -p packages/cli/dist
  printf '%s\n' 'process.stdout.write("bridge-ok\\n")' > packages/cli/dist/main.js
  exit 0
fi
exit 1
`);

  for (const version of ["1.2.3", "1.2.4-rc.1"]) {
    const source = join(root, `codex-channel-bridge-${version}`);
    await mkdir(source);
    await writeFile(join(source, "package.json"), `${JSON.stringify({ version })}\n`);
    const archive = `codex-channel-bridge-${version}.tar.gz`;
    run("tar", ["-czf", join(assets, archive), "-C", root, `codex-channel-bridge-${version}`]);
    const digest = run("shasum", ["-a", "256", join(assets, archive)]).stdout.split(/\s+/)[0];
    await writeFile(join(assets, `${archive}.sha256`), `${digest}  ${archive}\n`);
  }

  const baseUrl = pathToFileURL(assets).href;

  try {
    for (const version of ["1.2.3", "1.2.4-rc.1"]) {
      const result = run("sh", [join(repositoryRoot, "install.sh")], {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CODEX_CHANNEL_BRIDGE_VERSION: version,
        CODEX_CHANNEL_BRIDGE_RELEASE_BASE_URL: baseUrl,
        CODEX_CHANNEL_BRIDGE_INSTALL_ROOT: installRoot,
        CODEX_CHANNEL_BRIDGE_BIN_DIR: commandBin
      });
      assert.match(result.stdout, new RegExp(`Bridge ${version} is installed`));
    }
    assert.equal((await readFile(join(installRoot, "current"), "utf8")).trim(), "1.2.4-rc.1");
    assert.equal(run(join(commandBin, "bridge"), []).stdout.trim(), "bridge-ok");
    assert.equal((await readFile(join(installRoot, "versions/1.2.3/package.json"), "utf8")).trim(), '{"version":"1.2.3"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer scripts retain the Codex ownership and checksum gates", async () => {
  assert.equal(run("sh", ["-n", join(repositoryRoot, "install.sh")]).status, 0);
  const powershell = await readFile(join(repositoryRoot, "install.ps1"), "utf8");
  assert.match(powershell, /Codex CLI is required and must be installed by the host administrator/);
  assert.match(powershell, /Get-FileHash/);
  assert.match(powershell, /Move-Item -Force \$CurrentTemporary \$Current/);
});

async function executable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o700);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr}`);
  return result;
}
