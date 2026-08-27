import assert from "node:assert/strict";
import test from "node:test";

import { parseChannelText } from "./bridge-command.js";

test("treats ordinary text and double-slash escapes as Codex input", () => {
  assert.deepEqual(parseChannelText("run tests"), { kind: "ordinary", text: "run tests" });
  assert.deepEqual(parseChannelText("//status"), { kind: "ordinary", text: "/status" });
});

test("parses the registered command vocabulary once", () => {
  assert.deepEqual(parseChannelText("/status"), {
    kind: "command",
    command: { kind: "status" }
  });
  assert.deepEqual(parseChannelText("/attach thread-123"), {
    kind: "command",
    command: { kind: "thread.attach", threadId: "thread-123" }
  });
  assert.deepEqual(parseChannelText("/MODEL gpt-example"), {
    kind: "command",
    command: { kind: "model.select", modelId: "gpt-example" }
  });
  assert.deepEqual(parseChannelText("/approve token-1 session"), {
    kind: "command",
    command: {
      kind: "approval.respond",
      approvalToken: "token-1",
      decision: "acceptForSession"
    }
  });
});

test("fails unknown and malformed commands instead of sending them to Codex", () => {
  assert.deepEqual(parseChannelText("/unknown value"), {
    kind: "invalid_command",
    commandName: "unknown",
    reason: "unknown"
  });
  assert.deepEqual(parseChannelText("/attach"), {
    kind: "invalid_command",
    commandName: "attach",
    reason: "missing_argument"
  });
  assert.deepEqual(parseChannelText("/status now"), {
    kind: "invalid_command",
    commandName: "status",
    reason: "unexpected_argument"
  });
  assert.deepEqual(parseChannelText("/approve token-1 forever"), {
    kind: "invalid_command",
    commandName: "approve",
    reason: "unexpected_argument"
  });
});
