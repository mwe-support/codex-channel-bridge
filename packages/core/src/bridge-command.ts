export type BridgeCommand =
  | { readonly kind: "help" }
  | { readonly kind: "status" }
  | { readonly kind: "thread.new" }
  | { readonly kind: "thread.attach"; readonly threadId: string }
  | { readonly kind: "thread.detach" }
  | { readonly kind: "turn.stop" }
  | {
      readonly kind: "approval.respond";
      readonly approvalToken: string;
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel";
    }
  | { readonly kind: "model.read" }
  | { readonly kind: "reasoning.read" }
  | { readonly kind: "model.select"; readonly modelId: string }
  | { readonly kind: "reasoning.select"; readonly effort: string };

export type ParsedChannelText =
  | { readonly kind: "ordinary"; readonly text: string }
  | { readonly kind: "command"; readonly command: BridgeCommand }
  | {
      readonly kind: "invalid_command";
      readonly commandName: string;
      readonly reason: "unknown" | "missing_argument" | "unexpected_argument";
    };

/** Parse once after Access Policy and before Admission Control. */
export function parseChannelText(text: string): ParsedChannelText {
  if (text.startsWith("//")) return { kind: "ordinary", text: text.slice(1) };
  if (!text.startsWith("/")) return { kind: "ordinary", text };

  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text);
  if (!match) return { kind: "ordinary", text };
  const commandName = match[1]!.toLowerCase();
  const argument = match[2]?.trim();
  switch (commandName) {
    case "help":
      return noArgument(commandName, argument, { kind: "help" });
    case "status":
      return noArgument(commandName, argument, { kind: "status" });
    case "new":
      return noArgument(commandName, argument, { kind: "thread.new" });
    case "detach":
      return noArgument(commandName, argument, { kind: "thread.detach" });
    case "stop":
      return noArgument(commandName, argument, { kind: "turn.stop" });
    case "approve":
      return approvalCommand(commandName, argument);
    case "attach":
      return requiredArgument(commandName, argument, (threadId) => ({
        kind: "thread.attach",
        threadId
      }));
    case "model":
      if (!argument) return { kind: "command", command: { kind: "model.read" } };
      return requiredArgument(commandName, argument, (modelId) => ({
        kind: "model.select",
        modelId
      }));
    case "reasoning":
      if (!argument) return { kind: "command", command: { kind: "reasoning.read" } };
      return requiredArgument(commandName, argument, (effort) => ({
        kind: "reasoning.select",
        effort
      }));
    default:
      return { kind: "invalid_command", commandName, reason: "unknown" };
  }
}

function approvalCommand(commandName: string, argument: string | undefined): ParsedChannelText {
  if (!argument) return { kind: "invalid_command", commandName, reason: "missing_argument" };
  const parts = argument.split(/\s+/u);
  if (parts.length !== 2) {
    return { kind: "invalid_command", commandName, reason: "unexpected_argument" };
  }
  const [approvalToken, rawDecision] = parts as [string, string];
  const decision = rawDecision.toLowerCase() === "session"
    ? "acceptForSession"
    : rawDecision.toLowerCase();
  if (
    decision !== "accept" &&
    decision !== "acceptForSession" &&
    decision !== "decline" &&
    decision !== "cancel"
  ) {
    return { kind: "invalid_command", commandName, reason: "unexpected_argument" };
  }
  return {
    kind: "command",
    command: { kind: "approval.respond", approvalToken, decision }
  };
}

function noArgument(
  commandName: string,
  argument: string | undefined,
  command: BridgeCommand
): ParsedChannelText {
  return argument
    ? { kind: "invalid_command", commandName, reason: "unexpected_argument" }
    : { kind: "command", command };
}

function requiredArgument(
  commandName: string,
  argument: string | undefined,
  create: (argument: string) => BridgeCommand
): ParsedChannelText {
  return argument
    ? { kind: "command", command: create(argument) }
    : { kind: "invalid_command", commandName, reason: "missing_argument" };
}
