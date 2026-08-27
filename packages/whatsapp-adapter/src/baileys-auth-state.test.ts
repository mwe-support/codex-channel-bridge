import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AuthenticationState } from "baileys";

import {
  activateBaileysAuthGeneration,
  createStagedBaileysAuthState,
  openActiveBaileysAuthState,
  openBaileysAuthState
} from "./baileys-auth-state.js";

test("creates owner-only Baileys state and persists credentials and Signal keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-baileys-auth-"));
  const directoryPath = join(root, "active");
  try {
    const handle = await openBaileysAuthState({ directoryPath, createIfMissing: true });
    const state = handle.state as AuthenticationState;
    assert.equal((await lstat(directoryPath)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(directoryPath, "creds.json"))).mode & 0o777, 0o600);

    state.creds.registered = true;
    await handle.saveCredentials();
    await state.keys.set({ session: { "peer:1": Uint8Array.from([1, 2, 3]) } });

    const reopened = await openBaileysAuthState({ directoryPath });
    const reopenedState = reopened.state as AuthenticationState;
    assert.equal(reopenedState.creds.registered, true);
    const session = await reopenedState.keys.get("session", ["peer:1"]);
    assert.deepEqual([...session["peer:1"]!], [1, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for missing, insecure, or symlinked auth directories", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows ACL validation is a separate platform edge");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "bridge-baileys-auth-invalid-"));
  const missing = join(root, "missing");
  const insecure = join(root, "insecure");
  const linked = join(root, "linked");
  try {
    await assert.rejects(openBaileysAuthState({ directoryPath: missing }), /real directory/);
    await mkdir(insecure, { mode: 0o700 });
    await chmod(insecure, 0o755);
    await assert.rejects(openBaileysAuthState({ directoryPath: insecure }), /mode 700/);
    await symlink(insecure, linked);
    await assert.rejects(
      openBaileysAuthState({ directoryPath: linked, createIfMissing: true }),
      /real directory/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activates a registered staged generation through an atomic marker", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-baileys-generations-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  try {
    const first = await createStagedBaileysAuthState({ rootDirectoryPath });
    const firstState = first.state as AuthenticationState;
    firstState.creds.registered = true;
    await first.saveCredentials();
    assert.deepEqual(
      await activateBaileysAuthGeneration({
        rootDirectoryPath,
        generationId: first.generationId
      }),
      { previousGenerationId: null }
    );
    assert.equal((await openActiveBaileysAuthState({ rootDirectoryPath })).generationId, first.generationId);
    assert.equal(
      (await lstat(join(rootDirectoryPath, "active-generation.json"))).mode & 0o777,
      0o600
    );

    const second = await createStagedBaileysAuthState({ rootDirectoryPath });
    const secondState = second.state as AuthenticationState;
    secondState.creds.registered = true;
    await second.saveCredentials();
    assert.deepEqual(
      await activateBaileysAuthGeneration({
        rootDirectoryPath,
        generationId: second.generationId
      }),
      { previousGenerationId: first.generationId }
    );
    assert.equal((await openActiveBaileysAuthState({ rootDirectoryPath })).generationId, second.generationId);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects an unregistered generation without replacing active auth", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-baileys-unregistered-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  try {
    const first = await createStagedBaileysAuthState({ rootDirectoryPath });
    (first.state as AuthenticationState).creds.registered = true;
    await first.saveCredentials();
    await activateBaileysAuthGeneration({ rootDirectoryPath, generationId: first.generationId });

    const unregistered = await createStagedBaileysAuthState({ rootDirectoryPath });
    await assert.rejects(
      activateBaileysAuthGeneration({
        rootDirectoryPath,
        generationId: unregistered.generationId
      }),
      /not registered/
    );
    assert.equal((await openActiveBaileysAuthState({ rootDirectoryPath })).generationId, first.generationId);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
