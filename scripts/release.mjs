import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePrefix = "@codex-channel-bridge/";
const releasePattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const developmentPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev$/;

export function isReleaseVersion(value) {
  return releasePattern.test(value);
}

export function isProjectVersion(value) {
  return isReleaseVersion(value) || developmentPattern.test(value);
}

export function extractNotes(markdown, version) {
  const heading = `## [${version}] - `;
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`missing_changelog_entry:${version}`);
  const end = markdown.indexOf("\n## [", start + heading.length);
  return markdown.slice(start, end < 0 ? undefined : end).trimEnd() + "\n";
}

async function packageFiles() {
  const entries = await readdir(join(root, "packages"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, "packages", entry.name, "package.json"))
    .sort();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function updateInternalDependencies(manifest, version) {
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies"
  ]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (name.startsWith(packagePrefix)) manifest[section][name] = version;
    }
  }
}

async function prepare(version) {
  if (!isProjectVersion(version)) throw new Error(`invalid_project_version:${version ?? ""}`);

  const rootPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const files = await packageFiles();
  const rootManifest = await readJson(rootPath);
  const manifests = await Promise.all(files.map(readJson));
  const lock = await readJson(lockPath);

  rootManifest.version = version;
  for (const manifest of manifests) {
    manifest.version = version;
    updateInternalDependencies(manifest, version);
  }

  lock.version = version;
  lock.packages[""].version = version;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.startsWith("packages/")) {
      entry.version = version;
      updateInternalDependencies(entry, version);
    }
  }

  const writes = [
    writeFile(rootPath, `${JSON.stringify(rootManifest, null, 2)}\n`),
    writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`),
    writeFile(join(root, "docs", "VERSION"), `${version}\n`),
    writeFile(join(root, "docs", "zh", "VERSION"), `${version}\n`),
    writeFile(
      join(root, "packages", "core", "src", "version.ts"),
      `export const BRIDGE_VERSION = ${JSON.stringify(version)};\n`
    ),
    ...files.map((path, index) =>
      writeFile(path, `${JSON.stringify(manifests[index], null, 2)}\n`)
    )
  ];
  await Promise.all(writes);
  process.stdout.write(`${JSON.stringify({ event: "release_prepared", version })}\n`);
}

async function check(tag) {
  const rootManifest = await readJson(join(root, "package.json"));
  const version = rootManifest.version;
  if (!isProjectVersion(version)) throw new Error(`invalid_project_version:${version ?? ""}`);

  const files = await packageFiles();
  for (const path of files) {
    const manifest = await readJson(path);
    assertEqual(manifest.version, version, `${relative(root, path)}:version`);
    assertInternalDependencies(manifest, version, relative(root, path));
  }

  const lock = await readJson(join(root, "package-lock.json"));
  assertEqual(lock.version, version, "package-lock.json:version");
  assertEqual(lock.packages?.[""]?.version, version, "package-lock.json:root");
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith("packages/")) continue;
    assertEqual(entry.version, version, `package-lock.json:${path}:version`);
    assertInternalDependencies(entry, version, `package-lock.json:${path}`);
  }

  for (const path of [join(root, "docs", "VERSION"), join(root, "docs", "zh", "VERSION")]) {
    assertEqual((await readFile(path, "utf8")).trim(), version, relative(root, path));
  }
  assertEqual(
    (await readFile(join(root, "packages", "core", "src", "version.ts"), "utf8")).trim(),
    `export const BRIDGE_VERSION = ${JSON.stringify(version)};`,
    "packages/core/src/version.ts"
  );

  const changelogs = [join(root, "CHANGELOG.md"), join(root, "docs", "zh", "CHANGELOG.md")];
  const releaseHeadings = [];
  for (const path of changelogs) {
    const content = await readFile(path, "utf8");
    if (!content.includes("## [Unreleased]")) {
      throw new Error(`missing_unreleased_section:${relative(root, path)}`);
    }
    if (tag) releaseHeadings.push(extractNotes(content, version).split("\n", 1)[0]);
  }
  if (tag) assertEqual(releaseHeadings[1], releaseHeadings[0], "changelog_release_heading");

  if (tag) {
    if (!isReleaseVersion(version)) throw new Error(`non_release_version:${version}`);
    assertEqual(tag, `v${version}`, "git_tag");
  }

  process.stdout.write(`${JSON.stringify({ event: "release_check_passed", version, tag: tag ?? null })}\n`);
}

function assertInternalDependencies(manifest, version, location) {
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies"
  ]) {
    for (const [name, value] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith(packagePrefix)) {
        assertEqual(value, version, `${location}:${section}:${name}`);
      }
    }
  }
}

function assertEqual(actual, expected, location) {
  if (actual !== expected) throw new Error(`version_mismatch:${location}:${actual ?? "missing"}:${expected}`);
}

async function notes(version) {
  if (!isReleaseVersion(version)) throw new Error(`invalid_release_version:${version ?? ""}`);
  process.stdout.write(extractNotes(await readFile(join(root, "CHANGELOG.md"), "utf8"), version));
}

async function main() {
  const [command, value, ...rest] = process.argv.slice(2);
  if (rest.length > 0) throw new Error("invalid_arguments");
  if (command === "prepare") return prepare(value);
  if (command === "notes") return notes(value);
  if (command === "check") {
    if (value === undefined) return check();
    if (value === "--tag") throw new Error("missing_tag");
    if (!value.startsWith("--tag=")) throw new Error("invalid_arguments");
    return check(value.slice("--tag=".length));
  }
  throw new Error("usage:release.mjs prepare VERSION | check [--tag=vVERSION] | notes VERSION");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "release_failed"}\n`);
    process.exitCode = 1;
  }
}
