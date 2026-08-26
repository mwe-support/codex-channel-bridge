import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export function defaultControlEndpoint(): string {
  if (process.platform === "win32") {
    const identity = createHash("sha256").update(userInfo().username).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\codex-channel-bridge-${identity}`;
  }
  const uid = process.getuid?.();
  return join(tmpdir(), `codex-channel-bridge-${uid ?? "user"}`, "control.sock");
}

export function resolveControlEndpoint(override?: string): string {
  const endpoint = override ?? process.env.BRIDGE_CONTROL_ENDPOINT ?? defaultControlEndpoint();
  if (process.platform === "win32") {
    if (!endpoint.startsWith("\\\\.\\pipe\\")) {
      throw new Error("Windows control endpoint must be a named pipe path");
    }
    return endpoint;
  }
  if (!isAbsolute(endpoint)) throw new Error("Control endpoint must be an absolute path");
  return endpoint;
}

export async function prepareUnixControlEndpoint(endpoint: string): Promise<void> {
  const directory = dirname(endpoint);
  const existingDirectory = await lstat(directory).catch(() => null);
  if (!existingDirectory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error("Control endpoint directory must be a real directory");
  }
  assertOwnerAndMode(directoryMetadata.uid, directoryMetadata.mode, 0o700, "directory");

  const existingSocket = await lstat(endpoint).catch(() => null);
  if (!existingSocket) return;
  if (!existingSocket.isSocket() || existingSocket.isSymbolicLink()) {
    throw new Error("Control endpoint exists and is not a Unix socket");
  }
  assertOwner(existingSocket.uid, "socket");
  if (await unixSocketAcceptsConnections(endpoint)) {
    throw new Error("Control endpoint is already in use");
  }
  await unlink(endpoint);
}

export async function secureUnixControlSocket(endpoint: string): Promise<void> {
  await chmod(endpoint, 0o600);
  const metadata = await lstat(endpoint);
  if (!metadata.isSocket() || metadata.isSymbolicLink()) {
    throw new Error("Control endpoint is not a Unix socket after listen");
  }
  assertOwnerAndMode(metadata.uid, metadata.mode, 0o600, "socket");
}

export async function verifyUnixControlSocket(endpoint: string): Promise<void> {
  const metadata = await lstat(endpoint).catch(() => null);
  if (!metadata?.isSocket() || metadata.isSymbolicLink()) {
    throw new Error("Control endpoint is absent or is not a Unix socket");
  }
  assertOwnerAndMode(metadata.uid, metadata.mode, 0o600, "socket");
}

export async function removeUnixControlSocket(endpoint: string): Promise<void> {
  const metadata = await lstat(endpoint).catch(() => null);
  if (!metadata) return;
  if (!metadata.isSocket() || metadata.isSymbolicLink()) return;
  assertOwner(metadata.uid, "socket");
  await unlink(endpoint);
}

function assertOwnerAndMode(uid: number, mode: number, expected: number, label: string): void {
  assertOwner(uid, label);
  if ((mode & 0o777) !== expected) {
    throw new Error(`Control endpoint ${label} permissions must be ${expected.toString(8)}`);
  }
}

function assertOwner(uid: number, label: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && uid !== currentUid) {
    throw new Error(`Control endpoint ${label} must be owned by the service user`);
  }
}

async function unixSocketAcceptsConnections(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ path: endpoint });
    const finish = (active: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => finish(true), 250);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
