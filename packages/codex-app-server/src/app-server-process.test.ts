import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import {
  CodexAppServerProcess,
  createCodexChildEnvironment
} from "./app-server-process.js";
import { ProtocolFaultError } from "./jsonl-rpc-client.js";

test("emits one protocol fault when the App Server child exits unexpectedly", async (context) => {
  const fixture = await fakeAppServerExecutable(context, true);
  const runtime = new CodexAppServerProcess({
    executable: fixture.executable,
    codexHome: "/tmp/codex-home",
    workspace: fixture.workspace,
    bridgeVersion: "test"
  });
  let faults = 0;
  runtime.on("protocolFault", () => {
    faults += 1;
  });
  const fault = once(runtime, "protocolFault");
  await runtime.start();
  const [error] = await fault;
  assert(error instanceof ProtocolFaultError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(faults, 1);
  await runtime.stop();
});

test("does not report an intentional App Server stop as a protocol fault", async (context) => {
  const fixture = await fakeAppServerExecutable(context, false);
  const runtime = new CodexAppServerProcess({
    executable: fixture.executable,
    codexHome: "/tmp/codex-home",
    workspace: fixture.workspace,
    bridgeVersion: "test"
  });
  let faults = 0;
  runtime.on("protocolFault", () => {
    faults += 1;
  });
  await runtime.start();
  await runtime.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(faults, 0);
});

test("isolates the App Server child from Channel secrets and enclosing Codex sessions", () => {
  const environment = createCodexChildEnvironment(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/service",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      HTTPS_PROXY: "http://proxy.invalid",
      SystemRoot: "C:\\Windows",
      CODEX_HOME: "/wrong",
      CODEX_APP_TOOLS_PIPE_PATH: "/private/tool-pipe",
      CODEX_PERMISSION_PROFILE: ":workspace",
      CODEX_SESSION_ID: "session-id",
      QQ_APP_SECRET: "channel-secret",
      OPENAI_API_KEY: "deployment-wide-secret",
      BRIDGE_CONFIG_OVERRIDES_JSON: "sensitive"
    },
    "/profiles/profile-a/codex-home"
  );

  assert.equal(environment.CODEX_HOME, "/profiles/profile-a/codex-home");
  assert.equal(environment.PATH, "/usr/bin:/bin");
  assert.equal(environment.HOME, "/Users/service");
  assert.equal(environment.LANG, "en_US.UTF-8");
  assert.equal(environment.LC_ALL, "en_US.UTF-8");
  assert.equal(environment.HTTPS_PROXY, "http://proxy.invalid");
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.CODEX_APP_TOOLS_PIPE_PATH, undefined);
  assert.equal(environment.CODEX_PERMISSION_PROFILE, undefined);
  assert.equal(environment.CODEX_SESSION_ID, undefined);
  assert.equal(environment.QQ_APP_SECRET, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.BRIDGE_CONFIG_OVERRIDES_JSON, undefined);
});

async function fakeAppServerExecutable(
  context: test.TestContext,
  exitAfterInitialize: boolean
): Promise<{ readonly executable: string; readonly workspace: string }> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-fake-app-server-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const executable = join(directory, process.platform === "win32" ? "app-server" : "fake-app-server.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        userAgent: "fake",
        platformFamily: "unix",
        platformOs: "test",
        codexHome: "/tmp/codex-home"
      }
    }) + "\\n");
  } else if (message.method === "initialized" && ${JSON.stringify(exitAfterInitialize)}) {
    setImmediate(() => process.exit(23));
  }
});
`,
    { mode: 0o700 }
  );
  if (process.platform !== "win32") await chmod(executable, 0o700);
  return {
    executable: process.platform === "win32" ? process.execPath : executable,
    workspace: process.platform === "win32" ? directory : process.cwd()
  };
}
