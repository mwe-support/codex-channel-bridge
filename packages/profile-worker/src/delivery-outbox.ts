import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type ChannelDeliveryReceipt
} from "@codex-channel-bridge/core";
import type {
  ClaimOutboxOptions,
  OutboxDeliveryLease,
  OutboxSettlement,
  OutboxSettlementResult
} from "@codex-channel-bridge/profile-store";

const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;

export interface DeliveryOutboxStore {
  claimOutbox(options: ClaimOutboxOptions): Promise<readonly OutboxDeliveryLease[]>;
  settleOutbox(settlement: OutboxSettlement): Promise<OutboxSettlementResult>;
}

export interface DeliveryOutboxOptions {
  readonly store: DeliveryOutboxStore;
  readonly resolveAdapter: (lease: OutboxDeliveryLease) => ChannelAdapter | undefined;
  readonly clock?: () => number;
  readonly random?: () => number;
  readonly batchSize?: number;
  readonly leaseDurationMs?: number;
}

export interface DeliverySweepResult {
  readonly claimed: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly ambiguous: number;
  readonly deferred: number;
}

export class DeliveryOutbox {
  readonly #store: DeliveryOutboxStore;
  readonly #resolveAdapter: DeliveryOutboxOptions["resolveAdapter"];
  readonly #clock: () => number;
  readonly #random: () => number;
  readonly #batchSize: number;
  readonly #leaseDurationMs: number;
  #running = false;
  #stopped = false;
  #activeSweep?: Promise<DeliverySweepResult>;

  public constructor(options: DeliveryOutboxOptions) {
    this.#store = options.store;
    this.#resolveAdapter = options.resolveAdapter;
    this.#clock = options.clock ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    if (!Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1) {
      throw new RangeError("batchSize must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#leaseDurationMs) || this.#leaseDurationMs < 1) {
      throw new RangeError("leaseDurationMs must be a positive safe integer");
    }
  }

  public async deliverReady(): Promise<DeliverySweepResult> {
    if (this.#stopped || this.#running) return emptySweep();
    this.#running = true;
    const sweep = this.#runSweep();
    this.#activeSweep = sweep;
    try {
      return await sweep;
    } finally {
      this.#running = false;
      if (this.#activeSweep === sweep) this.#activeSweep = undefined;
    }
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    await this.#activeSweep?.then(
      () => undefined,
      () => undefined
    );
  }

  async #runSweep(): Promise<DeliverySweepResult> {
    const nowMs = this.#clock();
    const leases = await this.#store.claimOutbox({
      nowMs,
      leaseDurationMs: this.#leaseDurationMs,
      limit: this.#batchSize
    });
    const totals = mutableSweep(leases.length);
    for (const lease of leases) {
      const outcome = await this.#deliverOne(lease, nowMs);
      totals[outcome] += 1;
    }
    return totals;
  }

  async #deliverOne(
    lease: OutboxDeliveryLease,
    settledAtMs: number
  ): Promise<"accepted" | "rejected" | "ambiguous" | "deferred"> {
    const adapter = this.#resolveAdapter(lease);
    if (!adapter) {
      await this.#defer(lease, "adapter_unavailable", settledAtMs);
      return "deferred";
    }

    try {
      const receipt = await adapter.sendText({
        logicalResultId: lease.logicalResultId,
        segmentIndex: lease.segmentIndex,
        target: lease.target,
        ...(lease.providerReplySequence !== undefined
          ? { providerReplySequence: lease.providerReplySequence }
          : {}),
        text: lease.text
      });
      requireMatchingReceipt(receipt, lease);
      await this.#store.settleOutbox({
        outboxRecordId: lease.outboxRecordId,
        leaseToken: lease.leaseToken,
        outcome: "accepted",
        providerMessageId: receipt.providerMessageId,
        acceptedAtMs: receipt.acceptedAtMs
      });
      return "accepted";
    } catch (error) {
      if (error instanceof ChannelDeliveryError && error.outcome === "rejected") {
        await this.#store.settleOutbox({
          outboxRecordId: lease.outboxRecordId,
          leaseToken: lease.leaseToken,
          outcome: "rejected",
          reasonCode: "provider_rejected",
          settledAtMs
        });
        return "rejected";
      }
      if (error instanceof ChannelDeliveryError && error.outcome === "deferred") {
        await this.#defer(lease, "adapter_deferred", settledAtMs, error.retryAfterMs);
        return "deferred";
      }
      await this.#retryAmbiguous(
        lease,
        error instanceof ChannelDeliveryError ? "provider_ambiguous" : "delivery_exception",
        settledAtMs,
        error instanceof ChannelDeliveryError ? error.retryAfterMs : undefined
      );
      return "ambiguous";
    }
  }

  async #defer(
    lease: OutboxDeliveryLease,
    reasonCode: string,
    settledAtMs: number,
    retryAfterMs?: number
  ): Promise<void> {
    await this.#store.settleOutbox({
      outboxRecordId: lease.outboxRecordId,
      leaseToken: lease.leaseToken,
      outcome: "deferred",
      reasonCode,
      settledAtMs,
      retryAtMs: settledAtMs + this.#retryDelay(lease.attemptNumber, retryAfterMs)
    });
  }

  async #retryAmbiguous(
    lease: OutboxDeliveryLease,
    reasonCode: string,
    settledAtMs: number,
    retryAfterMs?: number
  ): Promise<void> {
    await this.#store.settleOutbox({
      outboxRecordId: lease.outboxRecordId,
      leaseToken: lease.leaseToken,
      outcome: "ambiguous",
      reasonCode,
      settledAtMs,
      retryAtMs: settledAtMs + this.#retryDelay(lease.attemptNumber, retryAfterMs)
    });
  }

  #retryDelay(attemptNumber: number, retryAfterMs?: number): number {
    const exponent = Math.min(Math.max(attemptNumber - 1, 0), 20);
    const base = Math.min(BASE_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
    const jitter = 0.8 + clampRandom(this.#random()) * 0.4;
    const genericDelay = Math.max(1, Math.round(base * jitter));
    const providerDelay =
      retryAfterMs !== undefined && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
        ? Math.min(retryAfterMs, MAX_RETRY_DELAY_MS)
        : 0;
    return Math.max(genericDelay, providerDelay);
  }
}

function requireMatchingReceipt(
  receipt: ChannelDeliveryReceipt,
  lease: OutboxDeliveryLease
): void {
  if (
    receipt.logicalResultId !== lease.logicalResultId ||
    receipt.segmentIndex !== lease.segmentIndex ||
    receipt.outcome !== "accepted" ||
    !receipt.providerMessageId ||
    !Number.isSafeInteger(receipt.acceptedAtMs) ||
    receipt.acceptedAtMs < 0
  ) {
    throw new ChannelDeliveryError("ambiguous", "Channel Adapter returned an invalid receipt");
  }
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, 0), 1);
}

function emptySweep(): DeliverySweepResult {
  return { claimed: 0, accepted: 0, rejected: 0, ambiguous: 0, deferred: 0 };
}

function mutableSweep(claimed: number): {
  claimed: number;
  accepted: number;
  rejected: number;
  ambiguous: number;
  deferred: number;
} {
  return { claimed, accepted: 0, rejected: 0, ambiguous: 0, deferred: 0 };
}
