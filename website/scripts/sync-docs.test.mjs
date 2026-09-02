import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markdownFiles, releaseMarkdown } from "./sync-docs.mjs";

test("markdownFiles ignores the Chinese mirror and keeps nested Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-docs-"));
  try {
    await mkdir(join(root, "nested"));
    await mkdir(join(root, "zh"));
    await writeFile(join(root, "index.md"), "English");
    await writeFile(join(root, "nested", "page.mdx"), "Nested");
    await writeFile(join(root, "zh", "index.md"), "Chinese");
    assert.deepEqual((await markdownFiles(root)).map((path) => path.slice(root.length + 1)).sort(), ["index.md", "nested/page.mdx"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("releaseMarkdown keeps doc links version-local and pins repository links", () => {
  assert.equal(
    releaseMarkdown("[doc](configuration.md) [root](../CHANGELOG.md)", "docs/development.md", "v1.2.3"),
    "[doc](configuration.md) [root](https://github.com/mwe-support/codex-channel-bridge/blob/v1.2.3/CHANGELOG.md)"
  );
});
