import type { InboundChannelEvent } from "./channel-adapter.js";

export type AccessPolicyMode = "deny" | "allowlist" | "open";

export interface AccessRule {
  readonly mode: AccessPolicyMode;
  readonly allow: readonly string[];
}

export interface ChannelAccessPolicy {
  readonly privateChats: AccessRule;
  readonly groupChats: AccessRule;
  readonly groupParticipants: AccessRule;
}

export type AccessDisposition =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "rejected";
      readonly reason: "private_chat_denied" | "group_chat_denied" | "group_participant_denied";
    };

export function evaluateChannelAccess(
  policy: ChannelAccessPolicy,
  event: InboundChannelEvent
): AccessDisposition {
  if (event.message.conversationKind === "private") {
    return allows(policy.privateChats, event.message.providerIdentity)
      ? { kind: "allowed" }
      : { kind: "rejected", reason: "private_chat_denied" };
  }
  if (!allows(policy.groupChats, event.replyTarget.providerConversationId)) {
    return { kind: "rejected", reason: "group_chat_denied" };
  }
  return allows(policy.groupParticipants, event.message.providerIdentity)
    ? { kind: "allowed" }
    : { kind: "rejected", reason: "group_participant_denied" };
}

function allows(rule: AccessRule, identity: string): boolean {
  if (rule.mode === "open") return true;
  if (rule.mode === "deny") return false;
  return rule.allow.includes(identity);
}
