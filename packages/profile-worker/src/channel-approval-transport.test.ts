import assert from "node:assert/strict";
import test from "node:test";

import { formatApprovalPrompt } from "./channel-approval-transport.js";
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

test("formats a content-free Approval command without exposing the JSON-RPC id", () => {
  const prompt = formatApprovalPrompt(approval);
  assert.match(prompt, /\/approve token-1 accept/);
  assert.doesNotMatch(prompt, /secret body|99/);
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
