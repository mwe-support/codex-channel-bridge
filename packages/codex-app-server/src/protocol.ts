export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface InitializeParams {
  readonly clientInfo: {
    readonly name: string;
    readonly title?: string;
    readonly version: string;
  };
  readonly capabilities?: {
    readonly experimentalApi?: boolean;
  };
}

export interface InitializeResponse {
  readonly userAgent: string;
  readonly platformFamily: string;
  readonly platformOs: string;
  readonly codexHome: string;
}

export interface ThreadStartResponse {
  readonly thread: {
    readonly id: string;
  };
  readonly model: string;
  readonly modelProvider: string;
  readonly cwd: string;
}

export interface TurnStartResponse {
  readonly turn: {
    readonly id: string;
    readonly status: string;
  };
}

export interface AgentMessageItem {
  readonly type: "agentMessage";
  readonly id: string;
  readonly text: string;
}
