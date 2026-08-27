import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelAccessPolicy, InboundChannelEvent } from "./index.js";
import { evaluateChannelAccess } from "./access-policy.js";

const policy: ChannelAccessPolicy = {
  privateChats: { mode: "allowlist", allow: ["private-user"] },
  groupChats: { mode: "allowlist", allow: ["group-1"] },
  groupParticipants: { mode: "allowlist", allow: ["member-1"] }
};

function event(kind: "private" | "group", identity: string, conversation = "group-1") {
  return {
    message: {
      profileId: "alpha",
      provider: "qq",
      channelAccountId: "qq-primary",
      channelAccountEpochId: "epoch-1",
      providerEventId: "event-1",
      conversationKey: `qq:qq-primary:${kind}:${conversation}`,
      conversationKind: kind,
      providerIdentity: identity,
      observedAtMs: 1_000,
      text: "hello"
    },
    attention: kind === "private" ? "direct" : "mention",
    replyTarget: {
      conversationKey: `qq:qq-primary:${kind}:${conversation}`,
      conversationKind: kind,
      providerConversationId: conversation
    }
  } satisfies InboundChannelEvent;
}

test("evaluates private identities independently from groups", () => {
  assert.deepEqual(evaluateChannelAccess(policy, event("private", "private-user", "private-user")), {
    kind: "allowed"
  });
  assert.deepEqual(evaluateChannelAccess(policy, event("private", "member-1", "member-1")), {
    kind: "rejected",
    reason: "private_chat_denied"
  });
});

test("requires both group conversation and participant policy", () => {
  assert.deepEqual(evaluateChannelAccess(policy, event("group", "member-1")), {
    kind: "allowed"
  });
  assert.deepEqual(evaluateChannelAccess(policy, event("group", "member-1", "other-group")), {
    kind: "rejected",
    reason: "group_chat_denied"
  });
  assert.deepEqual(evaluateChannelAccess(policy, event("group", "other-member")), {
    kind: "rejected",
    reason: "group_participant_denied"
  });
});

test("supports explicit deny and open modes", () => {
  assert.deepEqual(
    evaluateChannelAccess(
      {
        privateChats: { mode: "open", allow: [] },
        groupChats: { mode: "deny", allow: [] },
        groupParticipants: { mode: "open", allow: [] }
      },
      event("private", "anyone", "anyone")
    ),
    { kind: "allowed" }
  );
});
