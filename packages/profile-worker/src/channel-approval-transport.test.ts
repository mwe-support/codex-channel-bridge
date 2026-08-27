import assert from "node:assert/strict";
import test from "node:test";

import type {
  ChannelAdapter,
  ChannelTextDelivery,
  ProviderInboundEvent
} from "@codex-channel-bridge/core";

import {
  ChannelApprovalTransport,
  formatApprovalPrompt
} from "./channel-approval-transport.js";
import type { RoutedApprovalRequest } from "./codex-server-request-router.js";

const approval: RoutedApprovalRequest = {
  approvalToken: "token-1",
  request: {
    id: 99,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", command: "secret body" }
  },
  threadId: "thread-1",
  turnId: "turn-1",
  context: {
    profileId: "alpha",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    conversationKey: "qq:qq-primary:private:user-1",
    providerIdentity: "user-1",
    replyTarget: {
      conversationKey: "qq:qq-primary:private:user-1",
      conversationKind: "private",
      providerConversationId: "user-1"
    }
  }
};

class FakeAdapter implements ChannelAdapter {
  delivery?: ChannelTextDelivery;
  async start(_onEvent: (event: ProviderInboundEvent) => Promise<void>): Promise<void> {}
  async sendText(delivery: ChannelTextDelivery) {
    this.delivery = delivery;
    return {
      logicalResultId: delivery.logicalResultId,
      segmentIndex: delivery.segmentIndex,
      outcome: "accepted" as const,
      providerMessageId: "provider-message-1",
      acceptedAtMs: 1
    };
  }
  async stop(): Promise<void> {}
}

test("presents a content-free Approval command without exposing the JSON-RPC id", async () => {
  const adapter = new FakeAdapter();
  const result = await new ChannelApprovalTransport().present(approval, adapter);
  assert.equal(result.approvalToken, "token-1");
  assert.equal(adapter.delivery?.logicalResultId, "approval:token-1");
  assert.match(adapter.delivery?.text ?? "", /\/approve token-1 accept/);
  assert.doesNotMatch(adapter.delivery?.text ?? "", /secret body|99/);
});

test("labels file-change approvals separately", () => {
  assert.match(
    formatApprovalPrompt({
      ...approval,
      request: { ...approval.request, method: "item/fileChange/requestApproval" }
    }),
    /file changes/
  );
});

test("supports bounded summary and detailed presentation without changing authority", () => {
  const summary = formatApprovalPrompt(approval, "summary");
  const detailed = formatApprovalPrompt(approval, "detailed");
  assert.match(summary, /Command: secret body/);
  assert.match(detailed, /Command: secret body/);
  assert.doesNotMatch(formatApprovalPrompt(approval, "minimal"), /secret body/);
});
