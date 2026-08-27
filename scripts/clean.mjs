import { rm } from "node:fs/promises";

const paths = [
  "packages/core/dist",
  "packages/config/dist",
  "packages/codex-app-server/dist",
  "packages/profile-store/dist",
  "packages/qq-adapter/dist",
  "packages/whatsapp-adapter/dist",
  "packages/profile-worker/dist",
  "packages/supervisor/dist",
  "packages/control-plane/dist",
  "packages/cli/dist",
  "packages/core/tsconfig.tsbuildinfo",
  "packages/config/tsconfig.tsbuildinfo",
  "packages/codex-app-server/tsconfig.tsbuildinfo",
  "packages/profile-store/tsconfig.tsbuildinfo",
  "packages/qq-adapter/tsconfig.tsbuildinfo",
  "packages/whatsapp-adapter/tsconfig.tsbuildinfo",
  "packages/profile-worker/tsconfig.tsbuildinfo",
  "packages/supervisor/tsconfig.tsbuildinfo",
  "packages/control-plane/tsconfig.tsbuildinfo",
  "packages/cli/tsconfig.tsbuildinfo"
];

await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
