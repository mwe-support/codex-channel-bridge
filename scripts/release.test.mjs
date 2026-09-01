import assert from "node:assert/strict";
import test from "node:test";

import { extractNotes, isProjectVersion, isReleaseVersion } from "./release.mjs";

test("accepts project and release versions", () => {
  assert.equal(isProjectVersion("0.1.0-dev"), true);
  assert.equal(isReleaseVersion("1.2.3"), true);
  assert.equal(isReleaseVersion("1.2.3-rc.1"), true);
  assert.equal(isReleaseVersion("1.2.3-dev"), false);
  assert.equal(isProjectVersion("1.2.3-preview.1"), false);
  assert.equal(isProjectVersion("01.2.3"), false);
});

test("extracts exactly one release section", () => {
  const changelog = "# Changelog\n\n## [1.2.3] - 2026-09-01\n\n- fixed\n\n## [1.2.2] - 2026-08-01\n";
  assert.equal(extractNotes(changelog, "1.2.3"), "## [1.2.3] - 2026-09-01\n\n- fixed\n");
  assert.throws(() => extractNotes(changelog, "1.2.4"), /missing_changelog_entry/);
});
