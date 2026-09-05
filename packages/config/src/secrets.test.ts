import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { secureWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";

import { SecretResolutionError, SecretResolver } from "./secrets.js";

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-secret-test-"));
  secureWindowsOwnerOnlyPath(directory, "directory");
  context.after(async () => rm(directory, { force: true, recursive: true }));
  return directory;
}

test("resolves process environment before the persistent Profile secret file", async (context) => {
  const directory = await temporaryDirectory(context);
  const secretsFile = join(directory, "secrets.env");
  await writeFile(secretsFile, "TEST_VALUE=persistent\n", { mode: 0o600 });
  const resolver = await SecretResolver.open({
    secretsFile,
    environment: { TEST_VALUE: "process" }
  });
  assert.equal(await resolver.resolve("env:TEST_VALUE"), "process");
});

test("falls back to the fixed Profile secret file without evaluating dotenv syntax", async (context) => {
  const directory = await temporaryDirectory(context);
  const secretsFile = join(directory, "secrets.env");
  await writeFile(
    secretsFile,
    "FIRST='literal value'\nSECOND=plain-value\nTHIRD=$(not-executed)\n",
    { mode: 0o600 }
  );
  const resolver = await SecretResolver.open({ secretsFile, environment: {} });
  assert.equal(await resolver.resolve("env:FIRST"), "literal value");
  assert.equal(await resolver.resolve("env:SECOND"), "plain-value");
  assert.equal(await resolver.resolve("env:THIRD"), "$(not-executed)");
});

test("reads one-secret absolute files with owner-only permissions", async (context) => {
  const directory = await temporaryDirectory(context);
  const oneSecret = join(directory, "one-secret");
  await writeFile(oneSecret, "single-value\n", { mode: 0o600 });
  const resolver = await SecretResolver.open({ environment: {} });
  assert.equal(await resolver.resolve(`file:${oneSecret}`), "single-value");
});

test("rejects insecure, symlinked, malformed, and empty secret inputs", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix permission and symlink contract");
    return;
  }
  const directory = await temporaryDirectory(context);
  const insecure = join(directory, "insecure.env");
  await writeFile(insecure, "VALUE=secret\n", { mode: 0o600 });
  await chmod(insecure, 0o644);
  await assert.rejects(
    SecretResolver.open({ secretsFile: insecure, environment: {} }),
    (error: unknown) => error instanceof SecretResolutionError && error.reason === "insecure_secret_file"
  );

  const target = join(directory, "target.env");
  const link = join(directory, "link.env");
  await writeFile(target, "VALUE=secret\n", { mode: 0o600 });
  await symlink(target, link);
  await assert.rejects(
    SecretResolver.open({ secretsFile: link, environment: {} }),
    (error: unknown) => error instanceof SecretResolutionError && error.reason === "insecure_secret_file"
  );

  const malformed = join(directory, "malformed.env");
  await writeFile(malformed, "VALUE=$(command)\nVALUE=duplicate\n", { mode: 0o600 });
  await assert.rejects(
    SecretResolver.open({ secretsFile: malformed, environment: {} }),
    (error: unknown) => error instanceof SecretResolutionError && error.reason === "malformed_secret_file"
  );

  const resolver = await SecretResolver.open({ environment: { EMPTY: "" } });
  await assert.rejects(
    resolver.resolve("env:EMPTY"),
    (error: unknown) => error instanceof SecretResolutionError && error.reason === "secret_unavailable"
  );
});
