import type {
  PersistedSession,
  SessionPersistencePort
} from "@tencent-connect/qqbot-nodejs/protocol";

export interface QQGatewaySessionRepository {
  load(): Promise<PersistedSession | null>;
  save(session: PersistedSession): Promise<void>;
  clear(): Promise<void>;
}

export interface QQGatewayCheckpoint {
  readonly sessionId: string;
  readonly sequence: number;
}

/**
 * Adapts the pinned SDK's eager session callback into a post-archive checkpoint.
 * The SDK may dispatch messages concurrently, so later commits never pass an
 * earlier uncommitted message sequence.
 */
export class QQGatewaySessionCoordinator {
  readonly #repository: QQGatewaySessionRepository;
  readonly #onFailure: (error: Error) => void;
  #latest: PersistedSession | null = null;
  #durable: PersistedSession | null = null;
  #claims = new Map<number, { readonly checkpoint: QQGatewayCheckpoint; committed: boolean }>();
  #writeTail: Promise<void> = Promise.resolve();
  #restored = false;

  public readonly sdkPort: SessionPersistencePort;

  public constructor(
    repository: QQGatewaySessionRepository,
    onFailure: (error: Error) => void = () => undefined
  ) {
    this.#repository = repository;
    this.#onFailure = onFailure;
    this.sdkPort = {
      load: () => this.#durable,
      save: (session) => this.#stage(session),
      clear: () => this.#clearFromSdk()
    };
  }

  public async restore(): Promise<void> {
    if (this.#restored) return;
    const restored = await this.#repository.load();
    validateSession(restored);
    this.#latest = restored;
    this.#durable = restored;
    this.#restored = true;
  }

  public claimMessage(): QQGatewayCheckpoint | undefined {
    const latest = this.#latest;
    if (!latest?.sessionId || latest.lastSeq === null) return undefined;
    const checkpoint = { sessionId: latest.sessionId, sequence: latest.lastSeq };
    if (!this.#claims.has(checkpoint.sequence)) {
      this.#claims.set(checkpoint.sequence, { checkpoint, committed: false });
    }
    return checkpoint;
  }

  public async commitMessage(checkpoint: QQGatewayCheckpoint | undefined): Promise<void> {
    if (!checkpoint) throw new Error("QQ Gateway message has no resumable sequence");
    const claim = this.#claims.get(checkpoint.sequence);
    if (!claim || claim.checkpoint.sessionId !== checkpoint.sessionId) {
      throw new Error("QQ Gateway message checkpoint is stale");
    }
    claim.committed = true;
    await this.#flushCommittedPrefix();
  }

  public async commitControl(): Promise<void> {
    if ([...this.#claims.values()].some((claim) => !claim.committed)) return;
    const latest = this.#latest;
    if (!latest?.sessionId || latest.lastSeq === null) return;
    await this.#persist(latest);
  }

  public async settled(): Promise<void> {
    await this.#writeTail;
  }

  #stage(session: PersistedSession): void {
    validateSession(session);
    if (!session.sessionId) return;
    if (this.#latest && this.#latest.sessionId !== session.sessionId) {
      this.#claims.clear();
      this.#durable = null;
    }
    if (
      this.#latest?.sessionId === session.sessionId &&
      this.#latest.lastSeq !== null &&
      session.lastSeq !== null &&
      session.lastSeq < this.#latest.lastSeq
    ) {
      return;
    }
    this.#latest = { ...session };
  }

  async #flushCommittedPrefix(): Promise<void> {
    const ordered = [...this.#claims.values()].sort(
      (left, right) => left.checkpoint.sequence - right.checkpoint.sequence
    );
    let target: QQGatewayCheckpoint | undefined;
    for (const claim of ordered) {
      if (!claim.committed) break;
      target = claim.checkpoint;
    }
    if (!target) return;
    await this.#persist({ sessionId: target.sessionId, lastSeq: target.sequence });
    for (const sequence of [...this.#claims.keys()]) {
      if (sequence <= target.sequence) this.#claims.delete(sequence);
    }
  }

  async #persist(session: PersistedSession): Promise<void> {
    if (
      this.#durable?.sessionId === session.sessionId &&
      this.#durable.lastSeq !== null &&
      session.lastSeq !== null &&
      session.lastSeq <= this.#durable.lastSeq
    ) {
      return;
    }
    const write = this.#writeTail.then(async () => {
      await this.#repository.save(session);
      this.#durable = { ...session };
    });
    this.#writeTail = write.catch(() => undefined);
    return write;
  }

  #clearFromSdk(): void {
    this.#latest = null;
    this.#durable = null;
    this.#claims.clear();
    const write = this.#writeTail.then(() => this.#repository.clear());
    this.#writeTail = write.catch((error: unknown) => {
      this.#onFailure(asError(error));
    });
  }
}

function validateSession(session: PersistedSession | null): void {
  if (
    session !== null &&
    (!session.sessionId ||
      (session.lastSeq !== null &&
        (!Number.isSafeInteger(session.lastSeq) || session.lastSeq < 0)))
  ) {
    throw new Error("QQ Gateway session checkpoint is invalid");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("QQ Gateway session persistence failed");
}
