import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type SecurePathKind = "file" | "directory";

const helperScript = fileURLToPath(new URL("../windows/path-acl.ps1", import.meta.url));

export function assertWindowsOwnerOnlyPath(
  path: string,
  kind: SecurePathKind,
  recursive = false
): void {
  if (process.platform === "win32") run("verify", path, kind, recursive);
}

export function secureWindowsOwnerOnlyPath(path: string, kind: SecurePathKind): void {
  if (process.platform === "win32") run("secure", path, kind, false);
}

function run(action: "secure" | "verify", path: string, kind: SecurePathKind, recursive: boolean): void {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("Windows SystemRoot is unavailable");
  try {
    execFileSync(
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperScript,
        "-Action",
        action,
        "-Path",
        path,
        "-Kind",
        kind,
        ...(recursive ? ["-Recursive"] : [])
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000, windowsHide: true }
    );
  } catch {
    throw new Error("Windows path ACL is not owner-only");
  }
}
