import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export function parseOptions(args: readonly string[]): Record<string, string> {
  const options: Record<string, string> = Object.create(null);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--") || flag.length === 2) throw new Error("Expected a named --option; use --help");
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option --${key}`);
    if (["json", "stdin", "password-stdin", "open"].includes(key)) options[key] = "true";
    else {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      options[key] = value;
    }
  }
  return options;
}

export function rejectUnknownOptions(options: Record<string, string>, allowed: readonly string[]): void {
  const unknown = Object.keys(options).find((key) => key !== "json" && !allowed.includes(key));
  if (unknown) throw new Error(`Unknown option --${unknown}`);
}

export function required(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

export async function readStdin(maximumBytes = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maximumBytes) throw new Error("Standard input exceeds its byte limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function confirmPlan(label: string, digest: string, supplied?: string): Promise<boolean> {
  if (supplied !== undefined) {
    if (supplied !== digest) throw new Error("--confirm must match the full current plan digest");
    return true;
  }
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return (await prompt.question(`${label} [y/N]: `)).trim().toLowerCase() === "y"; }
  finally { prompt.close(); stdin.pause(); }
}

export async function readSecret(): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Use --stdin, --from-env, or --from-file outside an interactive terminal");
  const muted = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  const prompt = createInterface({ input: stdin, output: muted, terminal: true });
  stdout.write("Secret (input hidden): ");
  try {
    return await new Promise<string>((resolve, reject) => {
      prompt.once("SIGINT", () => { prompt.close(); reject(new Error("Secret entry cancelled")); });
      prompt.question("").then(resolve, reject);
    });
  } finally { prompt.close(); stdin.pause(); muted.end(); stdout.write("\n"); }
}

export function printJson(value: unknown): void { stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
