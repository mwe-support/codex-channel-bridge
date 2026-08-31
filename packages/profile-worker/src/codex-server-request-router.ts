import { randomUUID } from "node:crypto";

import type {
  JsonRpcId,
  JsonRpcRequest,
  ManagedCodexRpcRuntime
} from "@codex-channel-bridge/codex-app-server";
import type {
  AuthorizedParticipantContext,
  ChannelReplyTarget
} from "@codex-channel-bridge/core";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
]);

export interface ApprovalControllerContext extends AuthorizedParticipantContext {
  readonly replyTarget: ChannelReplyTarget;
}

export interface RoutedApprovalRequest {
  readonly approvalToken: string;
  readonly request: JsonRpcRequest;
  readonly context: ApprovalControllerContext;
  readonly threadId: string;
  readonly turnId: string;
}

export type ServerRequestDisposition =
  | { readonly kind: "approval"; readonly approval: RoutedApprovalRequest }
  | { readonly kind: "rejected"; readonly reason: "unsupported" | "invalid" | "uncontrolled" };

export interface CodexServerRequestRouterOptions {
  readonly approvalTimeoutMs?: number;
  readonly newApprovalToken?: () => string;
  readonly onExpired?: (approval: RoutedApprovalRequest) => void | Promise<void>;
}

interface PendingApproval {
  readonly approval: RoutedApprovalRequest;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

export class CodexServerRequestRouter {
  readonly #runtime: ManagedCodexRpcRuntime;
  readonly #approvalTimeoutMs: number;
  readonly #newApprovalToken: () => string;
  readonly #onExpired?: (approval: RoutedApprovalRequest) => void | Promise<void>;
  readonly #pendingByRequest = new Map<string, PendingApproval>();
  readonly #pendingByToken = new Map<string, PendingApproval>();

  public constructor(
    runtime: ManagedCodexRpcRuntime,
    options: CodexServerRequestRouterOptions = {}
  ) {
    this.#runtime = runtime;
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.#newApprovalToken = options.newApprovalToken ?? randomUUID;
    this.#onExpired = options.onExpired;
    if (!Number.isSafeInteger(this.#approvalTimeoutMs) || this.#approvalTimeoutMs < 1) {
      throw new RangeError("approvalTimeoutMs must be a positive safe integer");
    }
  }

  public async accept(
    request: JsonRpcRequest,
    resolveController: (threadId: string, turnId: string) => ApprovalControllerContext | undefined
  ): Promise<ServerRequestDisposition> {
    if (!APPROVAL_METHODS.has(request.method)) {
      await this.#runtime.respondError(request.id, {
        code: -32601,
        message: "This Codex Server Request is not supported by the Channel Bridge"
      });
      return { kind: "rejected", reason: "unsupported" };
    }
    const target = requestTarget(request.params);
    if (!target) {
      await this.#runtime.respondError(request.id, {
        code: -32602,
        message: "Approval Request is missing its Codex Thread or Turn identity"
      });
      return { kind: "rejected", reason: "invalid" };
    }
    const context = resolveController(target.threadId, target.turnId);
    if (!context) {
      await this.#runtime.respondError(request.id, {
        code: -32602,
        message: "Approval Request has no controlling Channel Participant"
      });
      return { kind: "rejected", reason: "uncontrolled" };
    }
    const key = requestKey(request.id);
    if (this.#pendingByRequest.has(key)) {
      await this.#runtime.respondError(request.id, {
        code: -32600,
        message: "Duplicate process-scoped Approval Request identifier"
      });
      return { kind: "rejected", reason: "invalid" };
    }
    const approvalToken = this.#allocateApprovalToken();
    const approval = { approvalToken, request, context, ...target };
    this.#registerPending(key, approval);
    return { kind: "approval", approval };
  }

  public async respond(
    requestId: JsonRpcId,
    context: AuthorizedParticipantContext,
    decision: "accept" | "acceptForSession" | "decline" | "cancel"
  ): Promise<void> {
    const key = requestKey(requestId);
    const pending = this.#pendingByRequest.get(key);
    if (!pending) throw new Error("Approval Request is not pending in this App Server generation");
    if (!sameParticipant(pending.approval.context, context)) {
      throw new Error("Channel Participant does not control this Approval Request");
    }
    await this.#respondPending(key, pending, decision);
  }

  public async respondByToken(
    approvalToken: string,
    context: AuthorizedParticipantContext,
    decision: "accept" | "acceptForSession" | "decline" | "cancel"
  ): Promise<void> {
    const pending = this.#pendingByToken.get(approvalToken);
    if (!pending) throw new Error("Approval token is not pending in this App Server generation");
    if (!sameParticipant(pending.approval.context, context)) {
      throw new Error("Channel Participant does not control this Approval Request");
    }
    await this.#respondPending(requestKey(pending.approval.request.id), pending, decision);
  }

  public async cancelUndeliverable(approvalToken: string): Promise<void> {
    const pending = this.#pendingByToken.get(approvalToken);
    if (!pending) return;
    await this.#respondPending(
      requestKey(pending.approval.request.id),
      pending,
      "cancel"
    );
  }

  public close(): void {
    for (const pending of this.#pendingByRequest.values()) clearTimeout(pending.timer);
    this.#pendingByRequest.clear();
    this.#pendingByToken.clear();
  }

  public pendingCount(): number {
    return this.#pendingByRequest.size;
  }

  public approvalForRequest(requestId: JsonRpcId): RoutedApprovalRequest | undefined {
    return this.#pendingByRequest.get(requestKey(requestId))?.approval;
  }

  async #respondPending(
    key: string,
    pending: PendingApproval,
    decision: "accept" | "acceptForSession" | "decline" | "cancel"
  ): Promise<void> {
    this.#removePending(key, pending);
    try {
      await this.#runtime.respond(pending.approval.request.id, { decision });
    } catch (error) {
      if (
        !this.#pendingByRequest.has(key) &&
        !this.#pendingByToken.has(pending.approval.approvalToken)
      ) {
        this.#registerPending(key, pending.approval);
      }
      throw error;
    }
  }

  async #expire(key: string): Promise<void> {
    const pending = this.#pendingByRequest.get(key);
    if (!pending) return;
    this.#removePending(key, pending);
    await this.#runtime.respond(pending.approval.request.id, { decision: "cancel" }).catch(
      () => undefined
    );
    await this.#onExpired?.(pending.approval);
  }

  #removePending(key: string, pending: PendingApproval): void {
    clearTimeout(pending.timer);
    this.#pendingByRequest.delete(key);
    this.#pendingByToken.delete(pending.approval.approvalToken);
  }

  #registerPending(key: string, approval: RoutedApprovalRequest): void {
    const timer = setTimeout(() => void this.#expire(key), this.#approvalTimeoutMs);
    timer.unref();
    const pending = { approval, timer };
    this.#pendingByRequest.set(key, pending);
    this.#pendingByToken.set(approval.approvalToken, pending);
  }

  #allocateApprovalToken(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const token = this.#newApprovalToken().trim();
      if (token && !/\s/u.test(token) && !this.#pendingByToken.has(token)) return token;
    }
    throw new Error("Unable to allocate a unique Approval token");
  }
}

function requestTarget(params: unknown): { readonly threadId: string; readonly turnId: string } | null {
  if (!isRecord(params)) return null;
  return typeof params.threadId === "string" && params.threadId.length > 0 &&
    typeof params.turnId === "string" && params.turnId.length > 0
    ? { threadId: params.threadId, turnId: params.turnId }
    : null;
}

function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function sameParticipant(
  expected: AuthorizedParticipantContext,
  actual: AuthorizedParticipantContext
): boolean {
  return expected.profileId === actual.profileId &&
    expected.channelAccountId === actual.channelAccountId &&
    expected.channelAccountEpochId === actual.channelAccountEpochId &&
    expected.conversationKey === actual.conversationKey &&
    expected.providerIdentity === actual.providerIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
