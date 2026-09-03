import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AuthenticationState } from "baileys";

import {
  activateBaileysAuthGeneration,
  clearBaileysAuthRevocationState,
  createStagedBaileysAuthState,
  forgetBaileysAuthState,
  markBaileysAuthRevocationUncertain,
  openActiveBaileysAuthState,
  openBaileysAuthState,
  readActiveBaileysProviderIdentity,
  readBaileysAuthRevocationState
} from "./baileys-auth-state.js";

test("creates owner-only Baileys state and persists credentials and Signal keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-baileys-auth-"));
  const directoryPath = join(root, "active");
  try {
    const handle = await openBaileysAuthState({ directoryPath, createIfMissing: true });
    const state = handle.state as AuthenticationState;
    if (process.platform !== "win32") {
      assert.equal((await lstat(directoryPath)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(directoryPath, "creds.json"))).mode & 0o777, 0o600);
    }

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
  const rootDirectoryPath = join(parent, "channel-auth", "wa-primary");
  try {
    const first = await createStagedBaileysAuthState({ rootDirectoryPath });
    if (process.platform !== "win32") {
      assert.equal((await lstat(join(parent, "channel-auth"))).mode & 0o777, 0o700);
    }
    const firstState = first.state as AuthenticationState;
    Object.assign(firstState.creds, {
      me: { id: "15551112222:1@s.whatsapp.net" },
      account: {}
    });
    await first.saveCredentials();
    assert.deepEqual(
      await activateBaileysAuthGeneration({
        rootDirectoryPath,
        generationId: first.generationId
      }),
      { previousGenerationId: null }
    );
    assert.equal((await openActiveBaileysAuthState({ rootDirectoryPath })).generationId, first.generationId);
    if (process.platform !== "win32") {
      assert.equal(
        (await lstat(join(rootDirectoryPath, "active-generation.json"))).mode & 0o777,
        0o600
      );
    }

    const second = await createStagedBaileysAuthState({ rootDirectoryPath });
    const secondState = second.state as AuthenticationState;
    Object.assign(secondState.creds, {
      me: { id: "15551112222:2@s.whatsapp.net" },
      account: {}
    });
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
    Object.assign((first.state as AuthenticationState).creds, {
      me: { id: "15551112222:1@s.whatsapp.net" },
      account: {}
    });
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

test("persists an uncertain revocation lock without exposing the provider identity", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-baileys-revocation-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  try {
    const generation = await createStagedBaileysAuthState({ rootDirectoryPath });
    const state = generation.state as AuthenticationState;
    state.creds.me = { id: "15551112222:7@s.whatsapp.net", name: "test" };
    Object.assign(state.creds, { account: {} });
    await generation.saveCredentials();
    await activateBaileysAuthGeneration({
      rootDirectoryPath,
      generationId: generation.generationId
    });
    assert.equal(
      await readActiveBaileysProviderIdentity({ rootDirectoryPath }),
      "15551112222@s.whatsapp.net"
    );
    assert.equal(await readBaileysAuthRevocationState({ rootDirectoryPath }), "clear");
    await markBaileysAuthRevocationUncertain({ rootDirectoryPath });
    assert.equal(await readBaileysAuthRevocationState({ rootDirectoryPath }), "uncertain");
    if (process.platform !== "win32") {
      assert.equal(
        (await lstat(join(rootDirectoryPath, "revocation-state.json"))).mode & 0o777,
        0o600
      );
    }
    await clearBaileysAuthRevocationState({ rootDirectoryPath });
    assert.equal(await readBaileysAuthRevocationState({ rootDirectoryPath }), "clear");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("forgets only the selected local Baileys account root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bridge-baileys-forget-"));
  const rootDirectoryPath = join(parent, "wa-primary");
  const siblingPath = join(parent, "preserve-sibling");
  try {
    await mkdir(siblingPath, { mode: 0o700 });
    const generation = await createStagedBaileysAuthState({ rootDirectoryPath });
    Object.assign((generation.state as AuthenticationState).creds, {
      me: { id: "15551112222:1@s.whatsapp.net" },
      account: {}
    });
    await generation.saveCredentials();
    await activateBaileysAuthGeneration({
      rootDirectoryPath,
      generationId: generation.generationId
    });
    await forgetBaileysAuthState({ rootDirectoryPath });
    await assert.rejects(lstat(rootDirectoryPath), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
    assert.equal((await lstat(siblingPath)).isDirectory(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
