import { assertWindowsOwnerOnlyPath, secureWindowsOwnerOnlyPath } from "@codex-channel-bridge/platform";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { loadConfiguration } from "@codex-channel-bridge/config";
import { probeCodexProtocol } from "@codex-channel-bridge/codex-app-server";
import { ControlPlaneClient, resolveControlEndpoint } from "@codex-channel-bridge/control-plane";
import { defaultConfigPath } from "./setup.js";
import { confirmPlan, parseOptions, printJson, readSecret, readStdin, rejectUnknownOptions } from "./terminal.js";

const execute = promisify(execFile);
interface ServicePlan {
  readonly name: string;
  readonly backend: "launchd-user" | "systemd-user" | "windows-scm";
  readonly identity: string;
  readonly node: string;
  readonly entry: string;
  readonly configPath: string;
  readonly endpoint: string | null;
  readonly registrationPath: string;
  readonly startup: string;
  readonly permissions: string;
  readonly definition: string;
  readonly logPath: string;
  readonly stopTimeoutMs: number;
  readonly runtimePath: string;
}

export async function runServiceCommand(area: string | undefined, action: string | undefined, args: readonly string[]): Promise<boolean | "installed"> {
  if (area !== "service") return false;
  if (!["install", "start", "stop", "restart", "status", "uninstall"].includes(action ?? "")) throw new Error("Use bridge service --help");
  const options = parseOptions(args);
  rejectUnknownOptions(options, ["name", ...(action === "install" ? ["config", "endpoint", "password-from-env", "password-stdin"] : []), ...(["install", "uninstall"].includes(action!) ? ["confirm"] : [])]);
  const name = options.name ?? "codex-channel-bridge";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("--name must contain lowercase letters, numbers and hyphens, starting with a letter");
  if (!["darwin", "linux", "win32"].includes(process.platform)) throw new Error("Unsupported native service platform");
  const metadata = join(homedir(), ".config", "codex-channel-bridge", "services", `${name}.json`);
  if (action === "install") {
    const plan = await planService(name, options.config ?? defaultConfigPath(), options.endpoint);
    const digest = hash(JSON.stringify(plan));
    if (!options.confirm) printJson({ ...plan, definition: undefined, metadataPath: metadata, confirmationRequired: digest, startsImmediately: false });
    if (!await confirmPlan("Register this service for the current identity?", digest, options.confirm)) return true;
    if (plan.backend === "windows-scm" && (await windowsService("identity")).elevated !== true) {
      throw new Error("SCM registration requires an elevated terminal running as the previewed identity. Configuration is preserved; rerun this same command there");
    }
    if (await exists(metadata) || await exists(plan.registrationPath) || await nativeRegistrationExists(plan)) throw new Error("Service registration already exists; uninstall it explicitly before replacing it");
    for (const file of await readdir(dirname(metadata)).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue;
      const other = await readPlan(join(dirname(metadata), file), file.slice(0, -5));
      if (other && (other.configPath === plan.configPath || other.endpoint === plan.endpoint)) throw new Error("This deployment already has a service registration; use its existing service name");
    }
    await serviceDirectory(dirname(metadata));
    await serviceDirectory(dirname(plan.registrationPath));
    if (plan.backend !== "windows-scm") await writeFile(plan.registrationPath, plan.definition, { flag: "wx", mode: 0o600 });
    try {
      await writeFile(metadata, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
      secureWindowsOwnerOnlyPath(metadata, "file");
      if (plan.backend === "windows-scm") {
        if (options["password-stdin"] && options["password-from-env"]) throw new Error("Choose one service password input source");
        const password = options["password-stdin"] ? (await readStdin()).replace(/\r?\n$/, "") :
          options["password-from-env"] ? process.env[options["password-from-env"]] ?? "" : await readSecret();
        if (!password) throw new Error("A no-echo password for the selected Windows service identity is required");
        await windowsService("install", name, metadata, { password });
      }
      if (plan.backend === "systemd-user") {
        await run("systemctl", ["--user", "daemon-reload"]);
        await run("systemctl", ["--user", "enable", `${name}.service`]);
      }
    } catch (error) {
      if (plan.backend === "windows-scm" && (await windowsService("status", name)).registered === true) {
        throw new Error("Windows service registration is incomplete; its registration and configuration are preserved for inspection");
      }
      if (plan.backend === "systemd-user") await run("systemctl", ["--user", "disable", `${name}.service`]).catch(() => undefined);
      await unlink(plan.registrationPath).catch(() => undefined);
      await unlink(metadata).catch(() => undefined);
      throw error;
    }
    printJson(await serviceStatus(plan));
    return "installed";
  }
  const plan = await readPlan(metadata, name);
  if (!plan) {
    if (action !== "status") throw new Error("Service is not registered; run bridge service install first");
    printJson({ name, registered: false, serviceRunning: false, supervisor: null });
    return true;
  }
  if (action === "uninstall") {
    const digest = hash(JSON.stringify(plan));
    if (!options.confirm) printJson({ name, registrationPath: plan.registrationPath, metadataPath: metadata, preserves: ["configuration", "Profile data", "Codex homes", "Workspaces"], confirmationRequired: digest });
    if (!await confirmPlan("Stop and remove this service registration?", digest, options.confirm)) return true;
  }
  if (action === "stop" || action === "restart" || action === "uninstall") {
    await stopService(plan);
    const until = Date.now() + plan.stopTimeoutMs;
    let observed;
    do {
      observed = await serviceStatus(plan);
      if (!observed.serviceRunning && observed.supervisor === null) break;
      await delay(200);
    } while (Date.now() < until);
    if (observed.serviceRunning || observed.supervisor !== null) throw new Error("Service stop did not establish Supervisor exit; registration is preserved for inspection");
  }
  if (action === "start" || action === "restart") {
    await startService(plan);
    const until = Date.now() + 65_000;
    while (Date.now() < until) {
      const observed = await serviceStatus(plan);
      if (observed.serviceRunning && observed.supervisor?.liveness === "live") break;
      await delay(250);
    }
  }
  if (action === "uninstall") {
    if (plan.backend === "systemd-user") await run("systemctl", ["--user", "disable", `${name}.service`]);
    if (plan.backend === "windows-scm") await windowsService("uninstall", name, metadata);
    await unlink(plan.registrationPath);
    await unlink(metadata);
    if (plan.backend === "systemd-user") await run("systemctl", ["--user", "daemon-reload"]);
  }
  const status = await serviceStatus(plan);
  printJson(status);
  if ((action === "start" || action === "restart") && (!status.serviceRunning || status.supervisor === null)) process.exitCode = 2;
  if ((action === "stop" || action === "uninstall") && status.serviceRunning) process.exitCode = 2;
  return true;
}

async function planService(name: string, configPath: string, endpoint?: string): Promise<ServicePlan> {
  const candidate = await loadConfiguration(configPath);
  configPath = await realpath(configPath);
  endpoint = resolveControlEndpoint(endpoint);
  if (process.env.BRIDGE_CONFIG_OVERRIDES_JSON) throw new Error("Persist intended service settings in config.yaml; transient environment overrides cannot be captured in service registration");
  for (const profile of Object.values(candidate.configuration.profiles).filter(profile => profile.enabled)) {
    if (!profile.codexExecutable) throw new Error("Set each enabled Profile's absolute codexExecutable before service registration; an interactive PATH is not a service prerequisite");
    await probeCodexProtocol(profile.codexExecutable);
  }
  const entry = fileURLToPath(new URL("./main.js", import.meta.url));
  const args = [process.execPath, entry, "supervisor", "run", "--config", configPath, ...(endpoint ? ["--endpoint", endpoint] : [])];
  if (args.some(value => /[\r\n\0]/.test(value))) throw new Error("Service paths cannot contain control characters");
  const backend = process.platform === "win32" ? "windows-scm" : process.platform === "darwin" ? "launchd-user" : "systemd-user";
  const registrationPath = backend === "windows-scm" ? join(homedir(), ".config", "codex-channel-bridge", "services", `${name}.exe`) : backend === "launchd-user" ? join(homedir(), "Library", "LaunchAgents", `org.${name}.plist`) : join(homedir(), ".config", "systemd", "user", `${name}.service`);
  const runtimePath = [...new Set([dirname(process.execPath), ...Object.values(candidate.configuration.profiles)
    .flatMap(profile => profile.codexExecutable ? [dirname(profile.codexExecutable)] : []),
    ...(process.platform === "win32" ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])])].join(delimiter);
  if (/[\r\n\0]/.test(runtimePath)) throw new Error("Service PATH cannot contain control characters");
  const exitTimeout = Math.ceil((candidate.configuration.supervisor.drainTimeoutMs + 2 * candidate.configuration.supervisor.childExitTimeoutMs + 5000) / 1000);
  const logPath = join(homedir(), ".config", "codex-channel-bridge", "services", `${name}.jsonl`);
  const definition = backend === "windows-scm" ? hash(await readFile(fileURLToPath(new URL("../../platform/windows/ServiceHost.cs", import.meta.url)), "utf8")) : backend === "launchd-user" ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>org.${name}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(runtimePath)}</string></dict><key>Umask</key><integer>63</integer><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(logPath)}</string><key>StandardErrorPath</key><string>/dev/null</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ExitTimeOut</key><integer>${exitTimeout}</integer><key>ProcessType</key><string>Background</string></dict></plist>\n` :
    `[Unit]\nDescription=Codex Channel Bridge (${name})\n[Service]\nType=simple\nUMask=0077\nEnvironment=${systemdQuote(`PATH=${runtimePath}`, false)}\nExecStart=${args.map(arg => systemdQuote(arg)).join(" ")}\nRestart=on-failure\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=${exitTimeout}\n[Install]\nWantedBy=default.target\n`;
  return { name, backend, identity: backend === "windows-scm" ? String((await windowsService("identity")).name) : userInfo().username, node: process.execPath, entry, configPath, endpoint: endpoint ?? null,
    registrationPath, definition, logPath, runtimePath, stopTimeoutMs: exitTimeout * 1000, startup: backend === "windows-scm" ? "automatic at system boot (SCM)" : backend === "launchd-user" ? "at user login" : "at user manager startup; boot requires administrator-enabled linger",
    permissions: backend === "windows-scm" ? "Run from an elevated terminal as this same identity; SCM create access, a service-logon password and Log on as a service right are required" : "current user only; no elevation or change of runtime identity" };
}
async function readPlan(path: string, name: string): Promise<ServicePlan | null> {
  if (!await exists(path)) return null;
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (process.platform !== "win32" && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)) || metadata.size > 1024 * 1024) throw new Error("Unsafe service metadata");
  assertWindowsOwnerOnlyPath(path, "file");
  const plan = JSON.parse(await readFile(path, "utf8")) as ServicePlan;
  const expected = process.platform === "win32" ? join(dirname(path), `${name}.exe`) : process.platform === "darwin" ? join(homedir(), "Library", "LaunchAgents", `org.${name}.plist`) : join(homedir(), ".config", "systemd", "user", `${name}.service`);
  if (plan.name !== name || plan.registrationPath !== expected || plan.identity !== (process.platform === "win32" ? (await windowsService("identity")).name : userInfo().username) || plan.backend !== (process.platform === "win32" ? "windows-scm" : process.platform === "darwin" ? "launchd-user" : "systemd-user")) throw new Error("Service identity or registration path changed");
  if (process.platform === "win32") assertWindowsOwnerOnlyPath(expected, "file");
  if (process.platform !== "win32" && await readFile(expected, "utf8") !== plan.definition) throw new Error("Service definition changed externally; inspect it before continuing");
  return plan;
}
async function startService(plan: ServicePlan): Promise<void> {
  if (await isRunning(plan)) return;
  if (plan.backend === "windows-scm") { await windowsService("start", plan.name, join(dirname(plan.registrationPath), `${plan.name}.json`)); return; }
  if (plan.backend === "launchd-user") {
    const domain = `gui/${process.getuid!()}`;
    const loaded = await execute("launchctl", ["print", `${domain}/org.${plan.name}`]).then(() => true, () => false);
    if (!loaded) await run("launchctl", ["bootstrap", domain, plan.registrationPath]);
    else await run("launchctl", ["kickstart", `${domain}/org.${plan.name}`]);
  } else await run("systemctl", ["--user", "start", `${plan.name}.service`]);
}
async function stopService(plan: ServicePlan): Promise<void> {
  if (plan.backend === "windows-scm") { await windowsService("stop", plan.name, join(dirname(plan.registrationPath), `${plan.name}.json`)); return; }
  if (plan.backend === "launchd-user") {
    const target = `gui/${process.getuid!()}/org.${plan.name}`;
    if (await execute("launchctl", ["print", target]).then(() => true, () => false)) await run("launchctl", ["bootout", target]);
  } else await run("systemctl", ["--user", "stop", `${plan.name}.service`]);
}
async function isRunning(plan: ServicePlan): Promise<boolean> {
  if (plan.backend === "windows-scm") return (await windowsService("status", plan.name)).running === true;
  if (plan.backend === "systemd-user") return execute("systemctl", ["--user", "is-active", "--quiet", `${plan.name}.service`]).then(() => true, () => false);
  return execute("launchctl", ["print", `gui/${process.getuid!()}/org.${plan.name}`]).then(result => /state = running/.test(result.stdout), () => false);
}
async function serviceStatus(plan: ServicePlan) {
  const serviceRunning = await isRunning(plan);
  const supervisor = await new ControlPlaneClient(plan.endpoint ?? undefined).request("status/get").catch(() => null);
  return { name: plan.name, backend: plan.backend, identity: plan.identity, registered: plan.backend === "windows-scm" ? (await windowsService("status", plan.name)).registered === true : await exists(plan.registrationPath), serviceRunning, supervisor };
}
async function run(executable: string, args: string[]): Promise<void> {
  await execute(executable, args, { timeout: 3_700_000, maxBuffer: 1024 * 1024 }).catch(() => { throw new Error(`${executable} ${args[0]} failed; inspect the native service manager and permissions`); });
}
async function exists(path: string): Promise<boolean> { return !!await lstat(path).catch(() => null); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
export function systemdQuote(value: string, expandVariables = true): string {
  // Environment= keeps dollars literal; ExecStart uses $$ for a literal dollar.
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return '"' + (expandVariables ? escaped.replaceAll("$", () => "$$") : escaped) + '"';
}

async function windowsService(action: string, name?: string, manifest?: string, input?: unknown): Promise<Record<string, unknown>> {
  const helper = fileURLToPath(new URL("../../platform/windows/service.ps1", import.meta.url));
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) { reject(new Error("Windows SystemRoot is unavailable")); return; }
    const child = execFile(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", action,
      ...(name ? ["-Name", name] : []), ...(manifest ? ["-Manifest", manifest] : [])],
      { windowsHide: true, timeout: 3_700_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) { reject(new Error(`Windows SCM ${action} failed (${/^[a-z_]+\s*$/.test(stderr) ? stderr.trim() : "native_service_error"}); inspect privileges, selected identity and service-logon prerequisites`)); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Windows service helper returned an invalid result")); }
      });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input === undefined ? "" : JSON.stringify(input));
  });
}

async function serviceDirectory(path: string): Promise<void> {
  const previous = await lstat(path).catch(() => null);
  if (!previous) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    secureWindowsOwnerOnlyPath(path, "directory");
  }
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink() || (process.platform !== "win32" && (current.uid !== process.getuid?.() || (current.mode & 0o022) !== 0))) throw new Error("Service directory must be owned by the current identity and protected from other writers");
  assertWindowsOwnerOnlyPath(path, "directory");
}

async function nativeRegistrationExists(plan: ServicePlan): Promise<boolean> {
  if (plan.backend === "windows-scm") return (await windowsService("status", plan.name)).registered === true;
  if (plan.backend === "systemd-user") {
    const result = await execute("systemctl", ["--user", "show", `${plan.name}.service`, "--property=LoadState", "--value"])
      .catch(() => { throw new Error("The systemd user manager is unavailable; inspect the user service environment"); });
    return result.stdout.trim() !== "not-found";
  }
  return execute("launchctl", ["print", `gui/${process.getuid!()}/org.${plan.name}`]).then(() => true, error => {
    if (error.code === 113) return false;
    throw new Error("The launchd user domain could not be inspected");
  });
}
