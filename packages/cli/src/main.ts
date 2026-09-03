#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import qrcode from "qrcode-terminal";

import { runArchiveMcp } from "@codex-channel-bridge/archive-mcp";
import { probeCodexProtocol } from "@codex-channel-bridge/codex-app-server";
import {
  ConfigurationValidationError,
  loadConfiguration
} from "@codex-channel-bridge/config";
import {
  AdministrationResponseError,
  ControlPlaneClient,
  ControlPlaneServer,
  SupervisorAdministration
} from "@codex-channel-bridge/control-plane";
import { ProfileWorker } from "@codex-channel-bridge/profile-worker";
import { Supervisor } from "@codex-channel-bridge/supervisor";
import { runInteractiveSetup } from "./setup.js";

const argv = process.argv.slice(2);
const [area, action, ...args] = argv;

try {
  if (area === "setup" && (action === "quick" || action === "full")) {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["config"]);
    await runInteractiveSetup({ mode: action, configPath: options.config });
  } else if (area === "status") {
    const options = parseOptions(argv.slice(1));
    rejectUnknownOptions(options, ["endpoint"]);
    const client = new ControlPlaneClient(options.endpoint);
    stdout.write(`${JSON.stringify(await client.request("status/get"), null, 2)}\n`);
  } else if (area === "doctor") {
    const options = parseOptions(argv.slice(1));
    rejectUnknownOptions(options, ["profile", "endpoint"]);
    const result = await new ControlPlaneClient(options.endpoint).request("doctor/run", {
      ...(options.profile === undefined ? {} : { profileId: options.profile })
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  } else if (area === "backup" && action === "prepare") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "manifest", "include-workspace", "endpoint"]);
    const includeWorkspace = options["include-workspace"] ?? "no";
    if (includeWorkspace !== "yes" && includeWorkspace !== "no") {
      throw new Error("--include-workspace must equal yes or no");
    }
    const result = await new ControlPlaneClient(options.endpoint).request("backup/prepare", {
      profileId: required(options, "profile"),
      manifestPath: required(options, "manifest"),
      includeWorkspace: includeWorkspace === "yes"
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (area === "backup" && action === "finish") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "manifest", "hold-token", "snapshot-confirmed", "endpoint"]);
    if (required(options, "snapshot-confirmed") !== "yes") {
      throw new Error("--snapshot-confirmed must equal yes");
    }
    const result = await new ControlPlaneClient(options.endpoint).request("backup/finish", {
      profileId: required(options, "profile"),
      manifestPath: required(options, "manifest"),
      holdToken: required(options, "hold-token"),
      snapshotConfirmed: true
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (area === "restore" && action === "validate") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "manifest", "endpoint"]);
    const result = await new ControlPlaneClient(options.endpoint).request("restore/validate", {
      profileId: required(options, "profile"),
      manifestPath: required(options, "manifest")
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 2;
  } else if (area === "audit" && action === "query") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "from-ms", "to-ms", "limit", "endpoint"]);
    const result = await new ControlPlaneClient(options.endpoint).request(
      "audit/query",
      auditSelection(options)
    );
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (area === "audit" && action === "export") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "from-ms", "to-ms", "limit", "destination", "endpoint"]);
    const result = await new ControlPlaneClient(options.endpoint).request("audit/export", {
      ...auditSelection(options),
      destination: required(options, "destination")
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (area === "audit" && action === "retain") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, [
      "profile",
      "before-ms",
      "confirm-count",
      "confirm-digest",
      "endpoint"
    ]);
    const client = new ControlPlaneClient(options.endpoint);
    const plan = await client.request("audit/retention-plan", {
      profileId: required(options, "profile"),
      beforeMs: boundedInteger(required(options, "before-ms"), "--before-ms", 0, Number.MAX_SAFE_INTEGER)
    });
    if (options["confirm-count"] === undefined || options["confirm-digest"] === undefined) {
      stdout.write(`${JSON.stringify({
        applied: false,
        ...plan,
        confirmationRequired: {
          profileId: plan.profileId,
          recordCount: plan.recordCount,
          selectionDigest: plan.selectionDigest
        }
      }, null, 2)}\n`);
    } else {
      const count = boundedInteger(options["confirm-count"], "--confirm-count", 0, Number.MAX_SAFE_INTEGER);
      if (count !== plan.recordCount || options["confirm-digest"] !== plan.selectionDigest) {
        throw new Error("Audit retention confirmation does not match the current plan");
      }
      const result = await client.request("audit/retention-apply", {
        planToken: plan.planToken,
        confirmProfileId: plan.profileId,
        confirmRecordCount: count,
        confirmSelectionDigest: options["confirm-digest"]
      });
      stdout.write(`${JSON.stringify({ applied: true, ...result }, null, 2)}\n`);
    }
  } else if (area === "support" && action === "bundle") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "from-ms", "to-ms", "output", "confirm", "endpoint"]);
    const client = new ControlPlaneClient(options.endpoint);
    const plan = await client.request("support/plan", {
      ...(options.profile === undefined ? {} : { profileIds: [options.profile] }),
      fromMs: boundedInteger(required(options, "from-ms"), "--from-ms", 0, Number.MAX_SAFE_INTEGER),
      toMs: boundedInteger(required(options, "to-ms"), "--to-ms", 0, Number.MAX_SAFE_INTEGER),
      outputPath: required(options, "output")
    });
    if (options.confirm === undefined) {
      stdout.write(`${JSON.stringify({
        created: false,
        ...plan,
        confirmationRequired: plan.planDigest
      }, null, 2)}\n`);
    } else {
      if (options.confirm !== plan.planDigest) throw new Error("--confirm must equal the Support Bundle plan digest");
      const result = await client.request("support/apply", {
        planToken: plan.planToken,
        confirmPlanDigest: options.confirm
      });
      stdout.write(`${JSON.stringify({ created: true, ...result }, null, 2)}\n`);
    }
  } else if (area === "circuit" && action === "reset") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "endpoint"]);
    const result = await new ControlPlaneClient(options.endpoint).request("circuit/reset", {
      profileId: required(options, "profile")
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (area === "config" && action === "check") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["config"]);
    const candidate = await loadConfiguration(required(options, "config"));
    stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          revision: candidate.revision,
          environmentOverrideApplied: candidate.environmentOverrideApplied,
          profiles: Object.values(candidate.configuration.profiles).map((profile) => ({
            profileId: profile.id,
            enabled: profile.enabled
          }))
        },
        null,
        2
      )}\n`
    );
  } else if (area === "config" && action === "apply") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["config", "confirm", "endpoint"]);
    const client = new ControlPlaneClient(options.endpoint);
    const plan = await client.request("config/plan", {
      configPath: required(options, "config")
    });
    if (!options.confirm) {
      stdout.write(
        `${JSON.stringify(
          {
            applied: false,
            confirmationRequired: plan.candidateRevision,
            previousRevision: plan.previousRevision,
            entries: plan.entries,
            expiresAt: plan.expiresAt
          },
          null,
          2
        )}\n`
      );
    } else {
      if (options.confirm !== plan.candidateRevision) {
        throw new Error("--confirm must equal the complete candidate revision");
      }
      const result = await client.request("config/apply", {
        planToken: plan.planToken,
        confirmRevision: options.confirm
      });
      stdout.write(`${JSON.stringify({ applied: true, ...result }, null, 2)}\n`);
    }
  } else if (area === "migrate" && action === "plan") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "endpoint"]);
    const client = new ControlPlaneClient(options.endpoint);
    const plan = await client.request("migrate/plan", {
      profileId: required(options, "profile")
    });
    stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else if (area === "migrate" && action === "apply") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, [
      "profile",
      "backup-manifest",
      "confirm",
      "snapshot-confirmed",
      "endpoint"
    ]);
    if (required(options, "snapshot-confirmed") !== "yes") {
      throw new Error("--snapshot-confirmed must equal yes");
    }
    const client = new ControlPlaneClient(options.endpoint);
    const plan = await client.request("migrate/plan", {
      profileId: required(options, "profile")
    });
    if (required(options, "confirm") !== plan.planDigest) {
      throw new Error("--confirm must equal the complete migration plan digest");
    }
    const result = await client.request("migrate/apply", {
      planToken: plan.planToken,
      confirmPlanDigest: options.confirm,
      backupManifestPath: required(options, "backup-manifest"),
      snapshotConfirmed: true
    });
    stdout.write(`${JSON.stringify({ applied: true, ...result }, null, 2)}\n`);
  } else if (area === "archive" && action === "mcp") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "state-directory"]);
    await runArchiveMcp({
      profileId: required(options, "profile"),
      stateDirectory: required(options, "state-directory")
    });
  } else if (area === "archive" && action === "purge") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, [
      "profile",
      "conversation",
      "before-ms",
      "confirm-profile",
      "confirm-count",
      "endpoint"
    ]);
    const profileId = required(options, "profile");
    const hasConversation = options.conversation !== undefined || options["before-ms"] !== undefined;
    if (hasConversation && (options.conversation === undefined || options["before-ms"] === undefined)) {
      throw new Error("--conversation and --before-ms must be supplied together");
    }
    const client = new ControlPlaneClient(options.endpoint);
    const plan = await client.request("archive/purge-plan", {
      profileId,
      ...(hasConversation
        ? {
            scope: "conversation_before",
            conversationKey: options.conversation,
            beforeMs: boundedInteger(options["before-ms"]!, "--before-ms", 0, Number.MAX_SAFE_INTEGER)
          }
        : { scope: "profile" })
    });
    if (options["confirm-profile"] === undefined || options["confirm-count"] === undefined) {
      stdout.write(`${JSON.stringify({
        applied: false,
        ...plan,
        confirmationRequired: {
          confirmProfile: plan.profileId,
          confirmCount: plan.messageCount
        }
      }, null, 2)}\n`);
    } else {
      const confirmCount = boundedInteger(
        options["confirm-count"],
        "--confirm-count",
        0,
        Number.MAX_SAFE_INTEGER
      );
      if (options["confirm-profile"] !== plan.profileId || confirmCount !== plan.messageCount) {
        throw new Error("Archive purge confirmation must match the complete Profile ID and expected count");
      }
      const result = await client.request("archive/purge-apply", {
        planToken: plan.planToken,
        confirmProfileId: options["confirm-profile"],
        confirmMessageCount: confirmCount
      });
      stdout.write(`${JSON.stringify({ applied: true, ...result }, null, 2)}\n`);
    }
  } else if (area === "profile" && action === "purge") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "confirm", "endpoint"]);
    const profileId = required(options, "profile");
    const client = new ControlPlaneClient(options.endpoint);
    const plan = await client.request("profile/purge-plan", { profileId });
    if (options.confirm === undefined) {
      stdout.write(`${JSON.stringify({
        applied: false,
        ...plan,
        confirmationRequired: plan.profileId
      }, null, 2)}\n`);
    } else {
      if (options.confirm !== plan.profileId) {
        throw new Error("--confirm must equal the complete Profile ID");
      }
      const result = await client.request("profile/purge-apply", {
        planToken: plan.planToken,
        confirmProfileId: options.confirm
      });
      stdout.write(`${JSON.stringify({ applied: true, ...result }, null, 2)}\n`);
    }
  } else if (area === "channel" && (action === "connect" || action === "disconnect")) {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "account", "endpoint"]);
    const client = new ControlPlaneClient(options.endpoint);
    const result = await client.request(`channel/${action}`, {
      profileId: required(options, "profile"),
      channelAccountId: required(options, "account")
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (area === "whatsapp" && action === "pair") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "account", "timeout-ms", "endpoint"]);
    if (!stdout.isTTY) throw new Error("WhatsApp pairing requires an interactive terminal");
    const timeoutMs = options["timeout-ms"] === undefined
      ? undefined
      : boundedInteger(options["timeout-ms"], "--timeout-ms", 1_000, 300_000);
    const client = new ControlPlaneClient(options.endpoint);
    const result = await client.request(
      "whatsapp/pair",
      {
        profileId: required(options, "profile"),
        channelAccountId: required(options, "account"),
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      },
      (event) => {
        if (event.kind !== "pairing_material" || event.material.kind !== "qr") return;
        stdout.write(`Scan this expiring WhatsApp QR code before ${new Date(event.material.expiresAtMs).toISOString()}:\n`);
        qrcode.generate(event.material.value, { small: true }, (rendered) => {
          stdout.write(`${rendered}\n`);
        });
      }
    );
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (area === "whatsapp" && action === "logout") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "account", "endpoint"]);
    const result = await new ControlPlaneClient(options.endpoint).request("whatsapp/logout", {
      profileId: required(options, "profile"),
      channelAccountId: required(options, "account")
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (area === "whatsapp" && action === "forget-local") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["profile", "account", "confirm", "endpoint"]);
    const accountId = required(options, "account");
    const result = await new ControlPlaneClient(options.endpoint).request("whatsapp/forget-local", {
      profileId: required(options, "profile"),
      channelAccountId: accountId,
      confirmChannelAccountId: required(options, "confirm")
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (area === "supervisor" && action === "run") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["config", "endpoint"]);
    const candidate = await loadConfiguration(required(options, "config"));
    const supervisor = new Supervisor();
    const controlPlane = new ControlPlaneServer({
      endpoint: options.endpoint,
      handler: new SupervisorAdministration(supervisor)
    });
    supervisor.on("health", (health) => {
      stdout.write(`${JSON.stringify({ event: "profile_health", ...health })}\n`);
    });
    try {
      const applied = await supervisor.apply(candidate);
      await controlPlane.start();
      stdout.write(
        `${JSON.stringify({ event: "supervisor_live", revision: applied.acceptedRevision })}\n`
      );
      await waitForStopSignal();
    } finally {
      await controlPlane.stop().catch(() => undefined);
      const status = await supervisor.stop();
      stdout.write(`${JSON.stringify({ event: "supervisor_stopped", liveness: status.liveness })}\n`);
    }
  } else if (area === "codex" && action === "probe") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["codex"]);
    const result = await probeCodexProtocol(options.codex ?? "codex");
    stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } else if (area === "codex" && action === "turn") {
    const options = parseOptions(args);
    rejectUnknownOptions(options, [
      "profile",
      "workspace",
      "codex-home",
      "state-directory",
      "thread",
      "codex"
    ]);
    const profileId = required(options, "profile");
    const workspace = required(options, "workspace");
    const codexHome = required(options, "codex-home");
    const stateDirectory = required(options, "state-directory");
    const prompt = (await readStdin()).trim();
    if (!prompt) throw new Error("Codex input must be supplied on stdin");
    const worker = new ProfileWorker({
      profileId,
      workspace,
      codexHome,
      stateDirectory,
      codexExecutable: options.codex
    });
    try {
      const health = await worker.start();
      if (health.readiness !== "ready") {
        throw new Error(`Profile unavailable: ${health.reason ?? "unknown"}`);
      }
      const result = await worker.runTurn(prompt, options.thread);
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await worker.stop();
    }
  } else {
    usage();
  }
} catch (error) {
  if (error instanceof ConfigurationValidationError) {
    process.stderr.write(`${error.message}\n${error.issues.map((issue) => `- ${issue}`).join("\n")}\n`);
  } else if (error instanceof AdministrationResponseError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}

function parseOptions(args: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) usage();
    const key = flag.slice(2);
    if (options[key] !== undefined) throw new Error(`Duplicate option --${key}`);
    options[key] = value;
  }
  return options;
}

function rejectUnknownOptions(options: Record<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(options).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`Unknown option --${unknown[0]}`);
}

function required(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

function boundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function auditSelection(options: Record<string, string>): {
  readonly profileId?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly limit?: number;
} {
  return {
    ...(options.profile === undefined ? {} : { profileId: options.profile }),
    ...(options["from-ms"] === undefined
      ? {}
      : { fromMs: boundedInteger(options["from-ms"], "--from-ms", 0, Number.MAX_SAFE_INTEGER) }),
    ...(options["to-ms"] === undefined
      ? {}
      : { toMs: boundedInteger(options["to-ms"], "--to-ms", 0, Number.MAX_SAFE_INTEGER) }),
    ...(options.limit === undefined
      ? {}
      : { limit: boundedInteger(options.limit, "--limit", 1, 500) })
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForStopSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  bridge setup quick [--config /absolute/path/config.yaml]",
      "  bridge setup full [--config /absolute/path/config.yaml]",
      "  bridge status [--endpoint /absolute/path/control.sock]",
      "  bridge doctor [--profile ID] [--endpoint /absolute/path/control.sock]",
      "  bridge backup prepare --profile ID --manifest /absolute/path/manifest.json [--include-workspace yes|no] [--endpoint PATH]",
      "  bridge backup finish --profile ID --manifest /absolute/path/manifest.json --hold-token TOKEN --snapshot-confirmed yes [--endpoint PATH]",
      "  bridge restore validate --profile ID --manifest /absolute/path/manifest.json [--endpoint PATH]",
      "  bridge audit query [--profile ID] [--from-ms N] [--to-ms N] [--limit N] [--endpoint PATH]",
      "  bridge audit export --destination /absolute/path/audit.json [--profile ID] [--from-ms N] [--to-ms N] [--limit N] [--endpoint PATH]",
      "  bridge audit retain --profile ID --before-ms N [--confirm-count N --confirm-digest DIGEST] [--endpoint PATH]",
      "  bridge support bundle --output /absolute/path/directory --from-ms N --to-ms N [--profile ID] [--confirm PLAN_DIGEST] [--endpoint PATH]",
      "  bridge circuit reset --profile ID [--endpoint PATH]",
      "  bridge config check --config /absolute/path/config.yaml",
      "  bridge config apply --config /absolute/path/config.yaml [--confirm FULL_REVISION] [--endpoint PATH]",
      "  bridge migrate plan --profile ID [--endpoint PATH]",
      "  bridge migrate apply --profile ID --backup-manifest /absolute/path/manifest.json --confirm FULL_PLAN_DIGEST --snapshot-confirmed yes [--endpoint PATH]",
      "  bridge channel connect --profile ID --account ID [--endpoint PATH]",
      "  bridge channel disconnect --profile ID --account ID [--endpoint PATH]",
      "  bridge whatsapp pair --profile ID --account ID [--timeout-ms 120000] [--endpoint PATH]",
      "  bridge whatsapp logout --profile ID --account ID [--endpoint PATH]",
      "  bridge whatsapp forget-local --profile ID --account ID --confirm FULL_ACCOUNT_ID [--endpoint PATH]",
      "  bridge archive mcp --profile ID --state-directory /absolute/path/to/profile-state",
      "  bridge archive purge --profile ID [--conversation EXACT_KEY --before-ms TIMESTAMP] [--confirm-profile ID --confirm-count COUNT] [--endpoint PATH]",
      "  bridge profile purge --profile ID [--confirm FULL_PROFILE_ID] [--endpoint PATH]",
      "  bridge supervisor run --config /absolute/path/config.yaml [--endpoint PATH]",
      "  bridge codex probe [--codex /absolute/path/to/codex]",
      "  printf 'message' | bridge codex turn --profile ID --workspace /absolute/path --codex-home /absolute/path --state-directory /absolute/path [--thread ID] [--codex PATH]"
    ].join("\n")
  );
}
