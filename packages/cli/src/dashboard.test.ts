import assert from "node:assert/strict";
import test from "node:test";

import { DashboardBackend } from "./dashboard.js";

test("dashboard exposes status and requires the exact planned revision before apply", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const backend = new DashboardBackend(async (method, params) => {
    calls.push({ method, params });
    if (method === "status/get") return {
      liveness: "live",
      bridgeVersion: "0.1.0-dev",
      configurationRevision: "old",
      profiles: []
    };
    if (method === "config/plan") return {
      planToken: "server-only-token",
      previousRevision: "old",
      candidateRevision: "next",
      entries: [{ profileId: "primary", action: "restart" }],
      expiresAt: 123
    };
    return { acceptedRevision: "next" };
  });

  assert.deepEqual((await backend.handle("GET", "status")).body, {
    liveness: "live",
    bridgeVersion: "0.1.0-dev",
    configurationRevision: "old",
    profiles: []
  });
  const plan = await backend.handle("POST", "config/plan", { configPath: "/tmp/config.yaml" });
  assert.deepEqual(plan.body, {
    previousRevision: "old",
    candidateRevision: "next",
    entries: [{ profileId: "primary", action: "restart" }],
    expiresAt: 123
  });
  assert.equal(JSON.stringify(plan.body).includes("server-only-token"), false);
  assert.equal((await backend.handle("POST", "config/apply", { confirmRevision: "wrong" })).status, 409);
  assert.equal((await backend.handle("POST", "config/apply", { confirmRevision: "next" })).status, 200);
  assert.deepEqual(calls.at(-1), {
    method: "config/apply",
    params: { planToken: "server-only-token", confirmRevision: "next" }
  });
  const events = await backend.handle("GET", "events");
  assert.equal(Array.isArray(events.body), true);
});
