import type { RoutedApprovalRequest } from "./codex-server-request-router.js";

export type ApprovalDetailLevel = "minimal" | "summary" | "detailed";

export function formatApprovalPrompt(
  approval: RoutedApprovalRequest,
  detail: ApprovalDetailLevel = "minimal"
): string {
  const operation = approval.request.method === "item/commandExecution/requestApproval"
    ? "command execution"
    : "file changes";
  const prefix = `/approve ${approval.approvalToken}`;
  const lines = [
    `Codex requests approval for ${operation}.`,
    ...approvalDetails(approval, detail),
    "Reply with exactly one decision:",
    `${prefix} accept`,
    `${prefix} session`,
    `${prefix} decline`,
    `${prefix} cancel`
  ];
  return lines.join("\n");
}

function approvalDetails(
  approval: RoutedApprovalRequest,
  detail: ApprovalDetailLevel
): readonly string[] {
  if (detail === "minimal" || !isRecord(approval.request.params)) return [];
  const params = approval.request.params;
  const lines: string[] = [];
  if (typeof params.reason === "string" && params.reason.trim()) {
    lines.push(`Reason: ${truncate(params.reason.trim(), detail === "summary" ? 240 : 500)}`);
  }
  if (approval.request.method === "item/commandExecution/requestApproval") {
    if (typeof params.command === "string" && params.command.trim()) {
      const command = detail === "summary" ? params.command.trim().split(/\r?\n/u)[0]! : params.command.trim();
      lines.push(`Command: ${truncate(command, detail === "summary" ? 320 : 2_500)}`);
    }
    if (detail === "detailed" && typeof params.cwd === "string" && params.cwd.trim()) {
      lines.push(`Working directory: ${truncate(params.cwd.trim(), 600)}`);
    }
  } else if (detail === "detailed" && typeof params.grantRoot === "string" && params.grantRoot.trim()) {
    lines.push(`Requested write root: ${truncate(params.grantRoot.trim(), 600)}`);
  }
  return lines;
}

function truncate(value: string, maximumCharacters: number): string {
  return value.length <= maximumCharacters
    ? value
    : `${value.slice(0, maximumCharacters - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
