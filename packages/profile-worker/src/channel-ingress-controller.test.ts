import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelAccessPolicy, InboundChannelEvent } from "@codex-channel-bridge/core";

import { AdmissionController } from "./admission-controller.js";
import { ChannelIngressController } from "./channel-ingress-controller.js";

const openPolicy: ChannelAccessPolicy = {
  privateChats: { mode: "open", allow: [] },
  groupChats: { mode: "open", allow: [] },
  groupParticipants: { mode: "open", allow: [] }
};

function event(overrides: Partial<InboundChannelEvent> = {}): InboundChannelEvent {
  return {
    message: {
      profileId: "alpha",
      provider: "qq",
      channelAccountId: "qq-primary",
      channelAccountEpochId: "epoch-1",
      providerEventId: "event-1",
      conversationKey: "qq:qq-primary:private:user-1",
      conversationKind: "private",
      providerConversationId: "user-1",
      providerIdentity: "user-1",
      observedAtMs: 1_000,
      text: "run tests"
    },
    attention: "direct",
    replyTarget: {
      conversationKey: "qq:qq-primary:private:user-1",
      conversationKind: "private",
      providerConversationId: "user-1"
    },
    ...overrides
  };
}

function ingress(mode: "steer" | "queue" = "steer") {
  return new ChannelIngressController(
    new AdmissionController({
      mode,
      maximumActiveTurns: 1,
      queueCapacity: 2,
      maximumQueueAgeMs: 100,
      accountRateLimit: 10,
      accountRateWindowMs: 1_000,
      ready: true
    })
  );
}

test("unlimited admission keeps QQ and WhatsApp group/private work independent", () => {
  for (const provider of ["qq", "whatsapp"] as const) {
    for (const mode of ["steer", "queue"] as const) {
      const controller = new ChannelIngressController(new AdmissionController({
        mode, maximumActiveTurns: null, queueCapacity: 2, maximumQueueAgeMs: 100,
        accountRateLimit: 10, accountRateWindowMs: 1000, ready: true
      }));
      const work = (kind: "group" | "private", record: string) => ({
        archiveRecordId: record,
        event: event({
          message: { ...event().message, provider, conversationKind: kind,
            conversationKey: `${provider}:${kind}`, providerEventId: record },
          attention: kind === "group" ? "mention" : "direct",
          replyTarget: { ...event().replyTarget, conversationKey: `${provider}:${kind}`, conversationKind: kind }
        }),
        accessPolicy: openPolicy,
        groupThreadScope: "conversation" as const
      });
      const group = work("group", "group");
      const dm = work("private", "private");
      assert.equal(controller.accept(group).disposition.kind, "start");
      controller.markTurnStarted("group", { threadId: "group-thread", turnId: "group-turn" });
      assert.equal(controller.accept(dm).disposition.kind, "start");
      controller.markTurnStarted("private", { threadId: "dm-thread", turnId: "dm-turn" });
      assert.equal(controller.accept(work("private", "follow-up")).disposition.kind, mode === "steer" ? "steer" : "queued");
      controller.release("group", 1001);
      assert.deepEqual(controller.activeTurnFor(dm), { kind: "allowed", target: { threadId: "dm-thread", turnId: "dm-turn" } });
      if (mode === "queue") assert.deepEqual(controller.release("private", 1002).ready.map((entry) => entry.archiveRecordId), ["follow-up"]);
    }
  }
});

test("applies access before commands and ordinary admission", () => {
  const controller = ingress();
  const denied = controller.accept({
    archiveRecordId: "archive-1",
    event: event(),
    accessPolicy: {
      ...openPolicy,
      privateChats: { mode: "deny", allow: [] }
    },
    groupThreadScope: "conversation"
  });
  assert.deepEqual(denied.disposition, {
    kind: "rejected",
    reason: "private_chat_denied"
  });

  const command = controller.accept({
    archiveRecordId: "archive-2",
    event: event({ message: { ...event().message, providerEventId: "event-2", text: "/status" } }),
    accessPolicy: openPolicy,
    groupThreadScope: "conversation"
  });
  assert.deepEqual(command.disposition, {
    kind: "command",
    command: { kind: "status" },
    work: command.disposition.kind === "command" ? command.disposition.work : undefined
  });
});

test("keeps passive group events archived but out of Codex admission", () => {
  const controller = ingress();
  const passive = controller.accept({
    archiveRecordId: "archive-1",
    event: event({ attention: "passive" }),
    accessPolicy: openPolicy,
    groupThreadScope: "conversation"
  });
  assert.deepEqual(passive.disposition, { kind: "passive" });
});

test("removes one slash from escaped ordinary input before Codex admission", () => {
  const controller = ingress();
  const decision = controller.accept({
    archiveRecordId: "archive-1",
    event: event({ message: { ...event().message, text: "//status" } }),
    accessPolicy: openPolicy,
    groupThreadScope: "conversation"
  });
  assert.equal(decision.disposition.kind, "start");
  if (decision.disposition.kind === "start") {
    assert.equal(decision.disposition.work.event.message.text, "/status");
  }
});

test("returns queued work and its full trusted payload on release", () => {
  const controller = ingress("queue");
  const first = {
    archiveRecordId: "archive-1",
    event: event(),
    accessPolicy: openPolicy,
    groupThreadScope: "conversation" as const
  };
  const second = {
    ...first,
    archiveRecordId: "archive-2",
    event: event({
      message: { ...event().message, providerEventId: "event-2", observedAtMs: 1_001 }
    })
  };
  assert.equal(controller.accept(first).disposition.kind, "start");
  assert.deepEqual(controller.accept(second).disposition, { kind: "queued", position: 1 });
  assert.deepEqual(controller.release("archive-1", 1_050).ready, [second]);
});

test("steers only after the exact admitted work reports its native Turn", () => {
  const controller = ingress("steer");
  const first = {
    archiveRecordId: "archive-1",
    event: event(),
    accessPolicy: openPolicy,
    groupThreadScope: "conversation" as const
  };
  assert.equal(controller.accept(first).disposition.kind, "start");
  controller.markTurnStarted("archive-1", { threadId: "thread-1", turnId: "turn-1" });
  const second = controller.accept({
    ...first,
    archiveRecordId: "archive-2",
    event: event({
      message: { ...event().message, providerEventId: "event-2", observedAtMs: 1_001 }
    })
  });
  assert.deepEqual(second.disposition, {
    kind: "steer",
    work: second.disposition.kind === "steer" ? second.disposition.work : undefined,
    target: { threadId: "thread-1", turnId: "turn-1" }
  });

  const otherParticipant = controller.accept({
    ...first,
    archiveRecordId: "archive-3",
    event: event({
      message: {
        ...event().message,
        providerEventId: "event-3",
        providerIdentity: "user-2",
        observedAtMs: 1_002
      }
    })
  });
  assert.deepEqual(otherParticipant.disposition, { kind: "rejected", reason: "busy" });
});
