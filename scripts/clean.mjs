import { rm } from "node:fs/promises";

const paths = [
  "packages/core/dist",
  "packages/codex-app-server/dist",
  "packages/profile-worker/dist",
  "packages/cli/dist",
  "packages/core/tsconfig.tsbuildinfo",
  "packages/codex-app-server/tsconfig.tsbuildinfo",
  "packages/profile-worker/tsconfig.tsbuildinfo",
  "packages/cli/tsconfig.tsbuildinfo"
];

await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
