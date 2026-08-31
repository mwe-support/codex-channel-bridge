import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import { CodexAppServerProcess } from "./app-server-process.js";
import { ProtocolFaultError } from "./jsonl-rpc-client.js";

test("emits one protocol fault when the App Server child exits unexpectedly", async (context) => {
  const executable = await fakeAppServerExecutable(context, true);
  const runtime = new CodexAppServerProcess({
    executable,
    codexHome: "/tmp/codex-home",
    workspace: process.cwd(),
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
  const executable = await fakeAppServerExecutable(context, false);
  const runtime = new CodexAppServerProcess({
    executable,
    codexHome: "/tmp/codex-home",
    workspace: process.cwd(),
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

async function fakeAppServerExecutable(
  context: test.TestContext,
  exitAfterInitialize: boolean
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-fake-app-server-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const executable = join(directory, "fake-app-server.mjs");
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
  await chmod(executable, 0o700);
  return executable;
}
