import { isAbsolute } from "node:path";

import { SecretResolver } from "@codex-channel-bridge/config";
import { QQChannelAdapter } from "@codex-channel-bridge/qq-adapter";

try {
  await run();
} catch (error) {
  const reason =
    error instanceof Error && error.message.startsWith("live_contract_")
      ? error.message
      : "live_contract_failed";
  process.stderr.write(`${JSON.stringify({ phase: "failed", reason })}\n`);
  process.exitCode = 1;
}

async function run() {
  const secretsFile = process.env.BRIDGE_QQ_LIVE_SECRETS_FILE;
  if (!secretsFile || !isAbsolute(secretsFile)) {
    throw new Error("live_contract_invalid_configuration");
  }

  const resolver = await SecretResolver.open({ secretsFile });
  const [appId, appSecret] = await resolveCredentialPair(resolver);
  const timeoutMs = boundedTimeout(process.env.BRIDGE_QQ_LIVE_TIMEOUT_MS);
  const adapter = new QQChannelAdapter({
    channelAccountId: "qq-live-contract",
    appId,
    appSecret
  });

  let settled = false;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectResult(new Error("live_contract_timeout"));
  }, timeoutMs);

  try {
    await adapter.start(async (event) => {
      if (settled) return;
      settled = true;
      try {
        const receipt = await adapter.sendText({
          logicalResultId: "qq-live-contract-result",
          segmentIndex: 0,
          target: {
            ...event.replyTarget,
            conversationKey: [
              "qq",
              "qq-live-contract",
              event.message.conversationKind,
              encodeURIComponent(event.message.providerConversationId)
            ].join(":")
          },
          providerReplySequence: 1,
          text: "Codex Channel Bridge QQ live contract OK"
        });
        resolveResult({
          phase: "completed",
          inbound: true,
          conversationKind: event.message.conversationKind,
          attention: event.attention,
          outbound: receipt.outcome
        });
      } catch {
        rejectResult(new Error("live_contract_delivery_failed"));
      }
    });
    process.stdout.write(`${JSON.stringify({ phase: "ready" })}\n`);
    process.stdout.write(`${JSON.stringify(await result)}\n`);
  } finally {
    clearTimeout(timer);
    await adapter.stop();
  }
}

async function resolveCredentialPair(secretResolver) {
  const configuredId = process.env.BRIDGE_QQ_APP_ID_REF;
  const configuredSecret = process.env.BRIDGE_QQ_APP_SECRET_REF;
  if ((configuredId && !configuredSecret) || (!configuredId && configuredSecret)) {
    throw new Error("live_contract_invalid_configuration");
  }
  const candidates = configuredId && configuredSecret
    ? [[configuredId, configuredSecret]]
    : [
        ["env:QQ_BOT_APP_ID", "env:QQ_BOT_APP_SECRET"],
        ["env:QQ_APP_ID", "env:QQ_APP_SECRET"],
        ["env:QQBOT_APP_ID", "env:QQBOT_APP_SECRET"],
        ["env:APP_ID", "env:APP_SECRET"]
      ];
  for (const [idReference, secretReference] of candidates) {
    try {
      return await Promise.all([
        secretResolver.resolve(idReference),
        secretResolver.resolve(secretReference)
      ]);
    } catch {
      // Continue without disclosing which Secret Reference exists.
    }
  }
  throw new Error("live_contract_credentials_unavailable");
}

function boundedTimeout(raw) {
  if (raw === undefined) return 120_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 300_000) {
    throw new Error("live_contract_invalid_configuration");
  }
  return value;
}
