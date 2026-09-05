import { createHash } from "node:crypto";
import type { ChannelAdapter, ChannelDeliveryReceipt, ChannelReplyTarget } from "@codex-channel-bridge/core";
import type { AnswerStreamRecord, BeginAnswerStreamInput, OutboxDeliveryLease } from "@codex-channel-bridge/profile-store";

export interface AnswerStreamStore {
  beginAnswerStream(input: BeginAnswerStreamInput): Promise<AnswerStreamRecord>;
  getAnswerStream(id: string): Promise<AnswerStreamRecord | undefined>;
  putAnswerStream(record: AnswerStreamRecord): Promise<void>;
}

interface ActiveStream {
  latest: string;
  sent: string;
  stopped: boolean;
  failed: boolean;
  timer?: NodeJS.Timeout;
  running?: Promise<void>;
}

/** Best-effort generation frames; only a durable Outbox lease can send DONE. */
export class ChannelAnswerStreams {
  readonly #active = new Map<string, ActiveStream>();
  public constructor(private readonly store: AnswerStreamStore) {}

  public start(id: string, target: ChannelReplyTarget, adapter: ChannelAdapter): {
    update(text: string): void; stop(): Promise<void>;
  } | undefined {
    if (!adapter.sendAnswerFrame || target.conversationKind !== "private" || !target.providerReplyEventId) return;
    if (this.#active.has(id)) throw new Error("Answer stream already registered");
    const active: ActiveStream = { latest: "", sent: "", stopped: false, failed: false };
    this.#active.set(id, active);
    const schedule = (delay: number): void => {
      if (active.stopped || active.failed || active.timer || active.running || active.latest === active.sent) return;
      active.timer = setTimeout(() => {
        active.timer = undefined;
        const text = active.latest;
        active.running = (async () => {
          const record = await this.store.beginAnswerStream({ archiveRecordId: id, target });
          if (!["idle", "ready"].includes(record.state) || !matchesPrefix(record, text)) {
            active.failed = true;
            return;
          }
          await this.#send(record, text, false, target, adapter);
          active.sent = text;
        })().catch(() => { active.failed = true; }).finally(() => {
          active.running = undefined;
          schedule(500);
        });
      }, delay);
      active.timer.unref();
    };
    return {
      update: (text) => {
        if (active.stopped || active.failed || !text || text.length > 5_000) return;
        active.latest = text;
        schedule(active.sent ? 500 : 0);
      },
      stop: () => this.#stop(id, active)
    };
  }

  public async finish(lease: OutboxDeliveryLease, adapter: ChannelAdapter): Promise<ChannelDeliveryReceipt | undefined> {
    const id = lease.answerStreamId;
    if (!id || lease.segmentIndex !== 0 || !adapter.sendAnswerFrame || lease.provider !== "qq" ||
        lease.target.conversationKind !== "private") return;
    const active = this.#active.get(id);
    if (active) await this.#stop(id, active);
    let record = await this.store.getAnswerStream(id);
    if (!record || record.state === "fallback") return;
    if (record.state === "done") {
      if (!matchesPrefix(record, lease.text) || record.prefixLength !== lease.text.length) {
        throw new Error("Completed stream does not match its durable result");
      }
      return receipt(lease, record);
    }
    // A crash during a frame send is uncertain. Never blindly replay that frame.
    if (active?.failed || record.state === "sending" || !matchesPrefix(record, lease.text) ||
        lease.text.length > 5_000) {
      await this.store.putAnswerStream({ ...record, state: "fallback" });
      return;
    }
    try {
      record = await this.#send(record, lease.text, true, lease.target, adapter);
    } catch {
      // Delivery-first fallback may duplicate a provider-accepted but unacknowledged DONE.
      await this.store.putAnswerStream({ ...record, state: "fallback" });
      return;
    }
    return receipt(lease, record);
  }

  public async stop(): Promise<void> {
    await Promise.all([...this.#active].map(([id, active]) => this.#stop(id, active)));
  }

  async #stop(id: string, active: ActiveStream): Promise<void> {
    active.stopped = true;
    clearTimeout(active.timer);
    active.timer = undefined;
    await active.running;
    this.#active.delete(id);
  }

  async #send(record: AnswerStreamRecord, text: string, done: boolean, target: ChannelReplyTarget,
    adapter: ChannelAdapter): Promise<AnswerStreamRecord> {
    // QQ's remain_msg_len is observation metadata, not an admission budget.
    // Keep the local bound and let actual provider rejections drive fallback.
    await this.store.putAnswerStream({ ...record, state: "sending" });
    const accepted = await adapter.sendAnswerFrame!({ target, text, done, index: record.nextIndex,
      providerReplySequence: record.replySequence,
      ...(record.providerMessageId ? { providerMessageId: record.providerMessageId } : {}) });
    if (!accepted.providerMessageId || (record.providerMessageId && record.providerMessageId !== accepted.providerMessageId)) {
      throw new Error("Native stream identity changed");
    }
    const updated: AnswerStreamRecord = { ...record, state: done ? "done" : "ready",
      nextIndex: record.nextIndex + 1, prefixLength: text.length, prefixSha256: digest(text),
      providerMessageId: accepted.providerMessageId, acceptedAtMs: accepted.acceptedAtMs,
      ...(accepted.remainingCharacters !== undefined ? { remainingCharacters: accepted.remainingCharacters } : {}) };
    await this.store.putAnswerStream(updated);
    return updated;
  }
}

function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function matchesPrefix(record: AnswerStreamRecord, text: string): boolean {
  return text.length >= record.prefixLength && digest(text.slice(0, record.prefixLength)) === record.prefixSha256;
}
function receipt(lease: OutboxDeliveryLease, record: AnswerStreamRecord): ChannelDeliveryReceipt {
  return { logicalResultId: lease.logicalResultId, segmentIndex: lease.segmentIndex, outcome: "accepted",
    providerMessageId: record.providerMessageId!, acceptedAtMs: record.acceptedAtMs! };
}
