import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type ChannelAdapterReadiness,
  type ChannelDeliveryReceipt,
  type ChannelTextDelivery,
  type ProviderInboundEvent
} from "@codex-channel-bridge/core";
import type {
  ClaimOutboxOptions,
  OutboxDeliveryLease,
  OutboxSettlement,
  OutboxSettlementResult
} from "@codex-channel-bridge/profile-store";
import { DeliveryOutbox, type DeliveryOutboxStore } from "./delivery-outbox.js";

class FakeStore implements DeliveryOutboxStore {
  readonly settlements: OutboxSettlement[] = [];
  claims: OutboxDeliveryLease[] = [];

  async claimOutbox(_options: ClaimOutboxOptions): Promise<readonly OutboxDeliveryLease[]> {
    return this.claims;
  }

  async settleOutbox(settlement: OutboxSettlement): Promise<OutboxSettlementResult> {
    this.settlements.push(settlement);
    return {
      outboxRecordId: settlement.outboxRecordId,
      logicalResultId: "result-1",
      status:
        settlement.outcome === "accepted"
          ? "accepted"
          : settlement.outcome === "rejected"
            ? "rejected"
            : "retry_wait"
    };
  }
}

class FakeAdapter implements ChannelAdapter {
  deliveries: ChannelTextDelivery[] = [];
  result: ChannelDeliveryReceipt | Error = {
    logicalResultId: "result-1",
    segmentIndex: 0,
    outcome: "accepted",
    providerMessageId: "provider-1",
    acceptedAtMs: 1_010
  };

  async start(_onEvent: (event: ProviderInboundEvent) => Promise<void>): Promise<void> {}

  readiness(): ChannelAdapterReadiness {
    return "ready";
  }

  subscribeReadiness(): () => void {
    return () => undefined;
  }

  async sendText(delivery: ChannelTextDelivery): Promise<ChannelDeliveryReceipt> {
    this.deliveries.push(delivery);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  async stop(): Promise<void> {}
}

function lease(overrides: Partial<OutboxDeliveryLease> = {}): OutboxDeliveryLease {
  return {
    outboxRecordId: "outbox-1",
    logicalResultId: "result-1",
    segmentIndex: 0,
    provider: "qq",
    channelAccountId: "qq-primary",
    channelAccountEpochId: "epoch-1",
    target: {
      conversationKey: "qq:qq-primary:private:user-1",
      conversationKind: "private",
      providerConversationId: "user-1"
    },
    providerReplySequence: 4,
    text: "terminal result",
    attemptNumber: 1,
    leaseToken: "lease-1",
    leaseExpiresAtMs: 2_000,
    ...overrides
  };
}

test("delivers a claimed record and persists only a matching accepted receipt", async () => {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  store.claims = [lease()];
  const outbox = new DeliveryOutbox({
    store,
    resolveAdapter: () => adapter,
    clock: () => 1_000,
    random: () => 0.5
  });

  assert.deepEqual(await outbox.deliverReady(), {
    claimed: 1,
    accepted: 1,
    rejected: 0,
    ambiguous: 0,
    deferred: 0
  });
  assert.equal(adapter.deliveries[0]?.logicalResultId, "result-1");
  assert.equal(adapter.deliveries[0]?.providerReplySequence, 4);
  assert.deepEqual(store.settlements, [
    {
      outboxRecordId: "outbox-1",
      leaseToken: "lease-1",
      outcome: "accepted",
      providerMessageId: "provider-1",
      acceptedAtMs: 1_010
    }
  ]);
});

test("a native DONE receipt settles the Outbox without an ordinary duplicate", async () => {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  store.claims = [lease({ answerStreamId: "archive-1" })];
  const outbox = new DeliveryOutbox({ store, resolveAdapter: () => adapter,
    finishAnswer: async (delivery, boundAdapter) => {
      assert.equal(boundAdapter, adapter);
      assert.equal(delivery.answerStreamId, "archive-1");
      return { logicalResultId: delivery.logicalResultId, segmentIndex: delivery.segmentIndex,
        outcome: "accepted", providerMessageId: "native-stream", acceptedAtMs: 1010 };
    } });
  assert.equal((await outbox.deliverReady()).accepted, 1);
  assert.equal(adapter.deliveries.length, 0);
  assert.equal(store.settlements[0]?.outcome, "accepted");
});

test("attachments bypass text streaming, keep their identity on retry, and fail closed without snapshots", async () => {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  const file = { sha256: "a".repeat(64), sizeBytes: 3, filename: "report.txt" };
  store.claims = [lease({ file, answerStreamId: "stream" })];
  let attempts = 0;
  const fileAdapter: ChannelAdapter = Object.assign(adapter, { sendFile: async (delivery: import("@codex-channel-bridge/core").ChannelFileDelivery) => {
    attempts++;
    assert.equal(delivery.logicalResultId, "result-1");
    assert.equal(delivery.providerReplySequence, 4);
    assert.deepEqual(delivery.bytes, Buffer.from("abc"));
    if (attempts === 1) throw new ChannelDeliveryError("ambiguous", "send outcome unknown");
    return adapter.result as ChannelDeliveryReceipt;
  } });
  const options = { store, resolveAdapter: () => fileAdapter,
    readOutputFile: async () => Buffer.from("abc"), finishAnswer: async () => { assert.fail("file is not a text stream"); } };
  assert.equal((await new DeliveryOutbox(options).deliverReady()).ambiguous, 1);
  assert.equal((await new DeliveryOutbox(options).deliverReady()).accepted, 1);
  assert.equal(adapter.deliveries.length, 0);
  assert.equal((await new DeliveryOutbox({ ...options, readOutputFile: async () => { throw new Error("missing"); } }).deliverReady()).rejected, 1);
  assert.equal(attempts, 2);
});

test("defers without sending when the bound Adapter is unavailable", async () => {
  const store = new FakeStore();
  store.claims = [lease()];
  const outbox = new DeliveryOutbox({
    store,
    resolveAdapter: () => undefined,
    clock: () => 1_000,
    random: () => 0.5
  });

  assert.equal((await outbox.deliverReady()).deferred, 1);
  assert.deepEqual(store.settlements[0], {
    outboxRecordId: "outbox-1",
    leaseToken: "lease-1",
    outcome: "deferred",
    reasonCode: "adapter_unavailable",
    settledAtMs: 1_000,
    retryAtMs: 2_000
  });
});

test("persists definite rejection and retries ambiguous outcomes with the same identity", async () => {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  const outbox = new DeliveryOutbox({
    store,
    resolveAdapter: () => adapter,
    clock: () => 1_000,
    random: () => 0.5
  });

  store.claims = [lease()];
  adapter.result = new ChannelDeliveryError("rejected", "provider rejected");
  assert.equal((await outbox.deliverReady()).rejected, 1);
  assert.equal(store.settlements[0]?.outcome, "rejected");

  store.claims = [lease({ attemptNumber: 2, leaseToken: "lease-2" })];
  adapter.result = new ChannelDeliveryError("ambiguous", "timeout");
  assert.equal((await outbox.deliverReady()).ambiguous, 1);
  assert.deepEqual(store.settlements[1], {
    outboxRecordId: "outbox-1",
    leaseToken: "lease-2",
    outcome: "ambiguous",
    reasonCode: "provider_ambiguous",
    settledAtMs: 1_000,
    retryAtMs: 3_000
  });
  assert.equal(adapter.deliveries[1]?.logicalResultId, "result-1");
});

test("treats a mismatched Adapter receipt as ambiguous after the send", async () => {
  const store = new FakeStore();
  const adapter = new FakeAdapter();
  store.claims = [lease()];
  adapter.result = { ...adapter.result as ChannelDeliveryReceipt, logicalResultId: "wrong" };
  const outbox = new DeliveryOutbox({
    store,
    resolveAdapter: () => adapter,
    clock: () => 1_000,
    random: () => 0.5
  });

  assert.equal((await outbox.deliverReady()).ambiguous, 1);
  assert.equal(store.settlements[0]?.outcome, "ambiguous");
});

test("does not overlap two sweeps for the same Profile", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new FakeStore();
  store.claimOutbox = async () => {
    await gate;
    return [];
  };
  const outbox = new DeliveryOutbox({ store, resolveAdapter: () => undefined });
  const first = outbox.deliverReady();
  assert.deepEqual(await outbox.deliverReady(), {
    claimed: 0,
    accepted: 0,
    rejected: 0,
    ambiguous: 0,
    deferred: 0
  });
  release();
  await first;
});
