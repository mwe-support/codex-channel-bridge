import assert from "node:assert/strict";
import test from "node:test";

import { parseConfiguration } from "@codex-channel-bridge/config";
import { collectConfiguration } from "./setup.js";

test("quick setup asks only for routing essentials and keeps advanced defaults", async () => {
  const answers = ["", "", "", "both", "", "open", "", "deny"];
  const raw = await collectConfiguration({
    question: async () => answers.shift() ?? ""
  }, "quick");
  const profile = parseConfiguration(JSON.stringify(raw)).configuration.profiles.primary!;
  assert.deepEqual(Object.keys(profile.channelAccounts), ["qq-primary", "wa-primary"]);
  assert.equal(profile.channelAccounts["qq-primary"]?.accessPolicy.privateChats.mode, "open");
  assert.equal(profile.channelAccounts["wa-primary"]?.accessPolicy.privateChats.mode, "deny");
  assert.equal(profile.admission.mode, "steer");
  assert.equal(profile.admission.maximumActiveTurns, null);
  assert.equal(profile.approval.detail, "minimal");
});

test("full setup exposes advanced Profile and Supervisor settings", async () => {
  const raw = await collectConfiguration({ question: async () => "" }, "full");
  const candidate = parseConfiguration(JSON.stringify(raw));
  const profile = candidate.configuration.profiles.primary!;
  assert.equal(profile.admission.queueCapacity, 16);
  assert.equal(profile.admission.maximumActiveTurns, null);
  assert.equal(profile.media.profileQuotaBytes, 10 * 1024 * 1024 * 1024);
  assert.equal(candidate.configuration.supervisor.diskSafetyFloorBytes, 512 * 1024 * 1024);
});

test("full setup can retain an explicit operator concurrency cap", async () => {
  const raw = await collectConfiguration({ question: async (label) =>
    label.startsWith("Concurrent Turns") ? "limited" :
      label.startsWith("Maximum active Turns") ? "2" : ""
  }, "full");
  assert.equal(parseConfiguration(JSON.stringify(raw)).configuration.profiles.primary!.admission.maximumActiveTurns, 2);
});
