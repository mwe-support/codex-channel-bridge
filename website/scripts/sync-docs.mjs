import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const website = dirname(dirname(fileURLToPath(import.meta.url)));
export const repository = join(website, "..");

export async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "zh") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (/\.mdx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

export function git(...args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" });
}

export function releaseMarkdown(markdown, source, tag) {
  return markdown.replace(/\]\(([^)#?]+)(#[^)]*)?\)/g, (match, target, fragment = "") => {
    if (/^(?:[a-z]+:|\/)/i.test(target)) return match;
    const resolved = posix.normalize(posix.join(posix.dirname(source), target));
    if (resolved.startsWith("docs/") && /\.mdx?$/.test(resolved)) return match;
    const kind = /\/$/.test(target) ? "tree" : "blob";
    return `](https://github.com/mwe-support/codex-channel-bridge/${kind}/${tag}/${resolved}${fragment})`;
  });
}

async function copyCurrentTranslations() {
  const docs = join(repository, "docs");
  const target = join(website, "i18n", "zh-Hans", "docusaurus-plugin-content-docs", "current");
  await rm(target, { recursive: true, force: true });
  for (const source of await markdownFiles(docs)) {
    const path = relative(docs, source);
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(docs, "zh", path), destination);
  }
}

async function writeRelease(release) {
  const prefix = `version-${release.version}`;
  const english = join(website, "versioned_docs", prefix);
  const chinese = join(website, "i18n", "zh-Hans", "docusaurus-plugin-content-docs", prefix);
  await rm(english, { recursive: true, force: true });
  await rm(chinese, { recursive: true, force: true });

  const paths = git("ls-tree", "-r", "--name-only", release.tag, "--", "docs")
    .trim()
    .split("\n")
    .filter((path) => /^docs\/(?!zh\/).*\.mdx?$/.test(path));

  for (const source of paths) {
    const path = source.slice("docs/".length);
    for (const [tagPath, target] of [[source, join(english, path)], [`docs/zh/${path}`, join(chinese, path)]]) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, releaseMarkdown(git("show", `${release.tag}:${tagPath}`), tagPath, release.tag));
    }
  }

  await writeFile(
    join(english, "CHANGELOG.md"),
    git("show", `${release.tag}:CHANGELOG.md`).replaceAll("](docs/", "](")
  );
  await writeFile(join(chinese, "CHANGELOG.md"), git("show", `${release.tag}:docs/zh/CHANGELOG.md`));

  const sidebars = await readFile(join(website, "release-sidebars.json"));
  const sidebarTarget = join(website, "versioned_sidebars", `${prefix}-sidebars.json`);
  await mkdir(dirname(sidebarTarget), { recursive: true });
  await writeFile(sidebarTarget, sidebars);
}

async function main() {
  const releases = JSON.parse(await readFile(join(website, "releases.json"), "utf8"));
  for (const release of releases) {
    const resolved = git("rev-list", "-n", "1", release.tag).trim();
    if (resolved !== release.commit) throw new Error(`${release.tag} resolves to ${resolved}, expected ${release.commit}`);
  }

  await copyCurrentTranslations();
  for (const release of releases) await writeRelease(release);
  await writeFile(join(website, "versions.json"), `${JSON.stringify(releases.map(({ version }) => version), null, 2)}\n`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    next: {
      productVersion: (await readFile(join(repository, "package.json"), "utf8")).match(/"version":\s*"([^"]+)"/)?.[1],
      docsVersion: (await readFile(join(repository, "docs", "VERSION"), "utf8")).trim(),
      sourceCommit: git("rev-parse", "HEAD").trim(),
      source: "current checkout"
    },
    releases
  };
  const manifestTarget = join(website, "static", "version-manifest.json");
  await mkdir(dirname(manifestTarget), { recursive: true });
  await writeFile(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
