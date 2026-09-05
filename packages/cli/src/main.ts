#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
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
import { BRIDGE_VERSION } from "@codex-channel-bridge/core";
import { ProfileWorker } from "@codex-channel-bridge/profile-worker";
import { Supervisor } from "@codex-channel-bridge/supervisor";
import { startDashboard } from "./dashboard.js";
import { runInteractiveSetup } from "./setup.js";
import { runServiceCommand } from "./service.js";
import { runModelCommand } from "./model.js";
import { runSettingsCommand } from "./settings.js";
import { parseOptions, rejectUnknownOptions, required, readStdin } from "./terminal.js";

const argv = process.argv.slice(2);
const [area, action, ...args] = argv;

try {
  if (area === undefined || area === "help" || argv.includes("--help")) {
    const group = area === "help" ? action : area?.startsWith("--") ? undefined : area;
    const lines = usageText().split("\n");
    const selected = group ? lines.filter((line) => line.startsWith(`  bridge ${group} `)) : lines;
    if (selected.length === 0) throw new Error(`Unknown command group: ${group}`);
    stdout.write(`${group ? "Usage:\n" : ""}${selected.join("\n")}\n`);
  } else if (await runSettingsCommand(area, action, args) || await runModelCommand(area, action, args) || await runServiceCommand(area, action, args)) {
    // Domain commands share configuration and control-plane operations.
  } else if ((area === "--version" || area === "version") && action === undefined) {
    stdout.write(`${BRIDGE_VERSION}\n`);
  } else if (area === "setup" && (action === undefined || action === "quick" || action === "full")) {
    const options = parseOptions(args);
    rejectUnknownOptions(options, ["config"]);
    await runInteractiveSetup({ mode: action ?? "quick", configPath: options.config });
  } else if (area === "dashboard") {
    const options = parseOptions(argv.slice(1));
    rejectUnknownOptions(options, ["endpoint", "port", "open"]);
    const dashboard = await startDashboard({
      endpoint: options.endpoint,
      port: options.port === undefined ? undefined : boundedInteger(options.port, "--port", 0, 65_535)
    });
    stdout.write(`Dashboard: ${dashboard.url}\n`);
    try {
      if (options.open) await new Promise<void>((resolve, reject) => {
        const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
        execFile(executable, process.platform === "win32" ? ["url.dll,FileProtocolHandler", dashboard.url] : [dashboard.url],
          { windowsHide: true, timeout: 10_000 }, error => error ? reject(new Error("Browser launch failed; use the printed Dashboard URL")) : resolve());
      });
      await waitForStopSignal();
    } finally { await dashboard.close(); }
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
    rejectUnknownOptions(options, ["config", "endpoint", "service-stdin"]);
    if (options["service-stdin"] !== undefined && options["service-stdin"] !== "yes") throw new Error("--service-stdin must equal yes");
    const serviceStdin = options["service-stdin"] === "yes";
    let serviceReady: (() => void) | undefined;
    const started = serviceStdin ? new Promise<void>(resolve => { serviceReady = resolve; }) : Promise.resolve();
    const stopped = waitForStopSignal(serviceStdin, serviceReady);
    // The Windows parent assigns its Job Object before allowing any Profile child to start.
    if (serviceStdin) await Promise.race([started, stopped.then(() => { throw new Error("Service parent stopped before startup"); })]);
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
      await stopped;
    } finally {
      const status = await supervisor.stop();
      await controlPlane.stop().catch(() => undefined);
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
  if (area === "supervisor" && argv.includes("--service-stdin")) stdin.destroy();
  if (error instanceof ConfigurationValidationError) {
    process.stderr.write(`${error.message}\n${error.issues.map((issue) => `- ${issue}`).join("\n")}\n`);
  } else if (error instanceof AdministrationResponseError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
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

async function waitForStopSignal(serviceStdin = false, onServiceStart?: () => void): Promise<void> {
  await new Promise<void>((resolve) => {
    const input = serviceStdin ? createInterface({ input: stdin }) : undefined;
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      input?.close();
      resolve();
    };
    input?.on("line", (line) => { if (line === "start") onServiceStart?.(); else if (line === "stop") stop(); });
    input?.once("close", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function usage(): never {
  throw new Error(usageText());
}

function usageText(): string {
  return (
    [
      "Usage:",
      "  bridge --version",
      "  bridge setup quick [--config /absolute/path/config.yaml]",
      "  bridge setup full [--config /absolute/path/config.yaml]",
      "  bridge config get [--config PATH] [--key profiles.primary.admission] [--json]",
      "  bridge config set --key PATH --value-json JSON [--config PATH] [--confirm EDIT_DIGEST]",
      "  bridge config edit [--config PATH] [--editor EXECUTABLE]",
      "  bridge service install --config PATH [--name NAME] [--endpoint PATH] [--confirm DIGEST] [--password-stdin | --password-from-env NAME]",
      "  bridge service start|stop|restart|status [--name NAME] [--json]",
      "  bridge service uninstall [--name NAME] [--confirm DIGEST]",
      "  bridge model list --profile ID [--endpoint PATH] [--json]",
      "  bridge model get --profile ID --scope defaults|thread [--thread ID] [--endpoint PATH]",
      "  bridge model set --profile ID --scope defaults|thread [--thread ID] [--model MODEL] [--effort EFFORT] [--confirm DIGEST] [--endpoint PATH]",
      "  bridge secret set --profile ID --name NAME [--config PATH] [--stdin | --from-env NAME | --from-file PATH]",
      "  bridge profile set --profile ID --key FIELD --value-json JSON [--config PATH] [--confirm DIGEST]",
      "  bridge profile enable|disable --profile ID [--config PATH] [--confirm DIGEST]",
      "  bridge channel set --profile ID --account ID --key FIELD --value-json JSON [--config PATH] [--confirm DIGEST]",
      "  bridge channel enable|disable --profile ID --account ID [--config PATH] [--confirm DIGEST]",
      "  bridge profile list [--config PATH] [--profile ID] [--json]",
      "  bridge profile status [--profile ID] [--endpoint PATH] [--json]",
      "  bridge channel list [--config PATH] [--profile ID] [--account ID] [--json]",
      "  bridge channel status [--profile ID] [--account ID] [--endpoint PATH] [--json]",
      "  bridge dashboard [--endpoint /absolute/path/control.sock] [--port 0] [--open]",
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
