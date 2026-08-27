import {
  evaluateChannelAccess,
  parseChannelText,
  type BridgeCommand,
  type ChannelAccessPolicy,
  type InboundChannelEvent,
  type ThreadBindingScope
} from "@codex-channel-bridge/core";

import {
  AdmissionController,
  type ActiveTurnTarget,
  type AdmissionDecision,
  type ExpiredAdmission
} from "./admission-controller.js";

export interface ChannelIngressInput {
  readonly archiveRecordId: string;
  readonly event: InboundChannelEvent;
  readonly accessPolicy: ChannelAccessPolicy;
  readonly groupThreadScope: ThreadBindingScope;
}

export type ChannelIngressDisposition =
  | { readonly kind: "passive" }
  | {
      readonly kind: "command";
      readonly command: BridgeCommand;
      readonly work: ChannelIngressInput;
    }
  | {
      readonly kind: "invalid_command";
      readonly commandName: string;
      readonly reason: "unknown" | "missing_argument" | "unexpected_argument";
    }
  | { readonly kind: "start"; readonly work: ChannelIngressInput }
  | {
      readonly kind: "steer";
      readonly work: ChannelIngressInput;
      readonly target: ActiveTurnTarget;
    }
  | { readonly kind: "queued"; readonly position: number }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "private_chat_denied"
        | "group_chat_denied"
        | "group_participant_denied"
        | "unavailable"
        | "busy"
        | "rate_limited"
        | "duplicate";
    };

export interface ExpiredChannelWork extends ExpiredAdmission {
  readonly work?: ChannelIngressInput;
}

export interface ChannelIngressDecision {
  readonly disposition: ChannelIngressDisposition;
  readonly expired: readonly ExpiredChannelWork[];
}

export interface ChannelIngressRelease {
  readonly ready: readonly ChannelIngressInput[];
  readonly expired: readonly ExpiredChannelWork[];
}

/** Access, attention, command, and ordinary-input admission in one order. */
export class ChannelIngressController {
  readonly #admission: AdmissionController;
  readonly #queued = new Map<string, ChannelIngressInput>();
  readonly #active = new Map<string, ChannelIngressInput>();
  readonly #turnTargets = new Map<string, ActiveTurnTarget>();

  public constructor(admission: AdmissionController) {
    this.#admission = admission;
  }

  public accept(input: ChannelIngressInput): ChannelIngressDecision {
    const alreadyExpired = this.#takeExpired(
      this.#admission.expire(input.event.message.observedAtMs)
    );
    const access = evaluateChannelAccess(input.accessPolicy, input.event);
    if (access.kind === "rejected") {
      return { disposition: access, expired: alreadyExpired };
    }
    if (input.event.attention === "passive" || !input.event.message.text?.trim()) {
      return { disposition: { kind: "passive" }, expired: alreadyExpired };
    }
    const parsed = parseChannelText(input.event.message.text);
    if (parsed.kind === "command") {
      return {
        disposition: { ...parsed, work: input },
        expired: alreadyExpired
      };
    }
    if (parsed.kind === "invalid_command") {
      return { disposition: parsed, expired: alreadyExpired };
    }

    const work =
      parsed.text === input.event.message.text
        ? input
        : {
            ...input,
            event: {
              ...input.event,
              message: { ...input.event.message, text: parsed.text }
            }
          };
    const threadKey = channelThreadKey(work.event, work.groupThreadScope);
    const admission = this.#admission.admit({
      workId: work.archiveRecordId,
      channelAccountId: work.event.message.channelAccountId,
      threadKey,
      providerIdentity: work.event.message.providerIdentity,
      receivedAtMs: work.event.message.observedAtMs
    });
    const expired = [...alreadyExpired, ...this.#takeExpired(admission.expired)];
    return {
      disposition: this.#toDisposition(admission, work),
      expired
    };
  }

  public markTurnStarted(archiveRecordId: string, target: ActiveTurnTarget): void {
    this.#admission.markTurnStarted(archiveRecordId, target);
    this.#turnTargets.set(archiveRecordId, target);
  }

  public activeTurnFor(input: ChannelIngressInput): ReturnType<AdmissionController["activeTurnFor"]> {
    return this.#admission.activeTurnFor(
      channelThreadKey(input.event, input.groupThreadScope),
      input.event.message.providerIdentity
    );
  }

  public release(archiveRecordId: string, nowMs: number): ChannelIngressRelease {
    this.#active.delete(archiveRecordId);
    this.#turnTargets.delete(archiveRecordId);
    const released = this.#admission.release(archiveRecordId, nowMs);
    return {
      ready: released.ready.flatMap((entry) => {
        const work = this.#queued.get(entry.workId);
        this.#queued.delete(entry.workId);
        return work ? [work] : [];
      }),
      expired: this.#takeExpired(released.expired)
    };
  }

  public setReady(ready: boolean, nowMs: number): ChannelIngressRelease {
    const released = this.#admission.setReady(ready, nowMs);
    return { ready: [], expired: this.#takeExpired(released.expired) };
  }

  public expire(nowMs: number): readonly ExpiredChannelWork[] {
    return this.#takeExpired(this.#admission.expire(nowMs));
  }

  public controllerForTurn(
    threadId: string,
    turnId: string
  ): ChannelIngressInput | undefined {
    for (const [workId, target] of this.#turnTargets) {
      if (target.threadId === threadId && target.turnId === turnId) {
        return this.#active.get(workId);
      }
    }
    return undefined;
  }

  #toDisposition(
    decision: AdmissionDecision,
    input: ChannelIngressInput
  ): ChannelIngressDisposition {
    switch (decision.disposition.kind) {
      case "start":
        this.#active.set(input.archiveRecordId, input);
        return { kind: "start", work: input };
      case "steer":
        return { kind: "steer", work: input, target: decision.disposition.target };
      case "queued":
        this.#queued.set(input.archiveRecordId, input);
        return { kind: "queued", position: decision.disposition.position };
      case "rejected":
        return { kind: "rejected", reason: decision.disposition.reason };
    }
  }

  #takeExpired(expired: readonly ExpiredAdmission[]): ExpiredChannelWork[] {
    return expired.map((entry) => {
      const work = this.#queued.get(entry.workId);
      this.#queued.delete(entry.workId);
      return { ...entry, ...(work ? { work } : {}) };
    });
  }
}

export function channelThreadKey(
  event: InboundChannelEvent,
  groupThreadScope: ThreadBindingScope
): string {
  const participantScoped =
    event.message.conversationKind === "group" && groupThreadScope === "participant";
  return participantScoped
    ? `${event.message.conversationKey}:participant:${encodeURIComponent(event.message.providerIdentity)}`
    : `${event.message.conversationKey}:conversation`;
}
