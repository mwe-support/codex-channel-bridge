import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputFileLinks, outputStoredBytes, readOutputFile, snapshotOutputFile } from "./output-files.js";

test("automatic handoff recognizes only bounded final-answer local Markdown links", () => {
  assert.deepEqual(outputFileLinks([
    "[one](report.txt) [same](report.txt) ![image](<images/plot one.png>)",
    "[web](https://example.com/file) [anchor](report.txt#L1) [share](//host/file)",
    "`[inline](no.txt)`", "    [indented](no.txt)", "> [quoted](no.txt)",
    "```", "[code](no.txt)", "```", "[three](/workspace/output.pdf)",
    "[four](four.txt) [five](five.txt)", "~~~", "[unfinished fence](no.txt)"
  ].join("\n")), ["report.txt", "images/plot one.png", "/workspace/output.pdf", "four.txt"]);
  assert.deepEqual(outputFileLinks("```\n```invalid-close\n[hidden](report.txt)"), []);
  assert.deepEqual(outputFileLinks("<!-- [hidden](report.txt) -->"), []);
});

test("snapshots survive original changes, enforce scope and quotas, detect tampering", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bridge-output-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const directory = join(root, "outbound-files");
  await mkdir(workspace, { mode: 0o700 });
  const path = join(workspace, "report.txt");
  await writeFile(path, "report", { mode: 0o600 });
  const options = { workspace, directory, excludedPaths: [], path: "report.txt", limitBytes: 20 };
  const file = await snapshotOutputFile(options);
  assert.equal(await outputStoredBytes(directory), 6);
  await writeFile(path, "changed");
  assert.equal(Buffer.from(await readOutputFile(directory, file)).toString(), "report");
  await assert.rejects(snapshotOutputFile({ ...options, limitBytes: 2 }));
  await assert.rejects(snapshotOutputFile({ ...options, excludedPaths: [path] }));
  await writeFile(join(root, "outside.txt"), "private");
  await assert.rejects(snapshotOutputFile({ ...options, path: "../outside.txt" }));
  await writeFile(join(workspace, ".env"), "private");
  await assert.rejects(snapshotOutputFile({ ...options, path: ".env" }));
  await writeFile(join(workspace, "test-channel.env.txt"), "private");
  await assert.rejects(snapshotOutputFile({ ...options, path: "test-channel.env.txt" }));
  await symlink(path, join(workspace, "alias.txt"));
  await assert.rejects(snapshotOutputFile({ ...options, path: "alias.txt" }));
  await symlink(root, join(workspace, "parent"));
  await assert.rejects(snapshotOutputFile({ ...options, path: "parent/outside.txt" }));
  await link(path, join(workspace, "hard.txt"));
  await assert.rejects(snapshotOutputFile({ ...options, path: "hard.txt" }));
  await writeFile(join(directory, file.sha256), "broken");
  await assert.rejects(readOutputFile(directory, file));
  await chmod(directory, 0o777);
  if (process.platform !== "win32") await assert.rejects(outputStoredBytes(directory));
});
