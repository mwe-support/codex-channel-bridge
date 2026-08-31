import assert from "node:assert/strict";
import test from "node:test";

import {
  isSupervisorToWorkerMessage,
  isWorkerToSupervisorMessage
} from "./worker-ipc.js";

test("accepts only bounded typed WhatsApp lifecycle actions", () => {
  assert.equal(isSupervisorToWorkerMessage({
    type: "whatsapp_action",
    requestId: "request-1",
    channelAccountId: "wa-primary",
    action: { kind: "pair", timeoutMs: 120_000 }
  }), true);
  assert.equal(isSupervisorToWorkerMessage({
    type: "whatsapp_action",
    requestId: "request-1",
    channelAccountId: "wa-primary",
    action: { kind: "pair", timeoutMs: 900_000 }
  }), false);
  assert.equal(isSupervisorToWorkerMessage({
    type: "whatsapp_action",
    requestId: "request-1",
    channelAccountId: "wa-primary",
    action: { kind: "forget_local" }
  }), false);
});

test("accepts pairing material only as a correlated Worker event", () => {
  assert.equal(isWorkerToSupervisorMessage({
    type: "whatsapp_action_event",
    requestId: "request-1",
    event: {
      kind: "pairing_material",
      material: { kind: "qr", value: "sensitive-test-qr", expiresAtMs: 123 }
    }
  }), true);
  assert.equal(isWorkerToSupervisorMessage({
    type: "whatsapp_action_event",
    requestId: "",
    event: {
      kind: "pairing_material",
      material: { kind: "qr", value: "sensitive-test-qr", expiresAtMs: 123 }
    }
  }), false);
});
