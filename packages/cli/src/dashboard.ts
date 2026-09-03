import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  AdministrationResponseError,
  ControlPlaneClient
} from "@codex-channel-bridge/control-plane";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS = 100;

interface DashboardOptions {
  readonly endpoint?: string;
  readonly port?: number;
}

interface DashboardEvent {
  readonly at: string;
  readonly action: string;
  readonly outcome: "observed" | "succeeded" | "failed";
  readonly code?: string;
}

interface DashboardReply {
  readonly status: number;
  readonly body: unknown;
}

type ControlRequest = (method: "status/get" | "config/plan" | "config/apply", params?: unknown) => Promise<unknown>;

export class DashboardBackend {
  readonly #request: ControlRequest;
  readonly #events: DashboardEvent[] = [];
  #lastStatus = "";
  #pendingPlan?: { readonly revision: string; readonly token: string };

  public constructor(request: ControlRequest) {
    this.#request = request;
  }

  public async handle(method: string, route: string, body?: unknown): Promise<DashboardReply> {
    try {
      if (method === "GET" && route === "status") {
        const status = await this.#request("status/get");
        const current = JSON.stringify(status);
        if (current !== this.#lastStatus) {
          this.#lastStatus = current;
          this.#record("status", "observed");
        }
        return { status: 200, body: status };
      }
      if (method === "GET" && route === "events") {
        return { status: 200, body: this.#events };
      }
      if (method === "POST" && route === "config/plan") {
        const configPath = stringField(body, "configPath");
        const plan = await this.#request("config/plan", { configPath }) as {
          readonly planToken: string;
          readonly candidateRevision: string;
          readonly previousRevision: string | null;
          readonly entries: readonly unknown[];
          readonly expiresAt: number;
        };
        this.#pendingPlan = { revision: plan.candidateRevision, token: plan.planToken };
        this.#record("config_plan", "succeeded");
        return {
          status: 200,
          body: {
            previousRevision: plan.previousRevision,
            candidateRevision: plan.candidateRevision,
            entries: plan.entries,
            expiresAt: plan.expiresAt
          }
        };
      }
      if (method === "POST" && route === "config/apply") {
        const confirmRevision = stringField(body, "confirmRevision");
        const pending = this.#pendingPlan;
        if (!pending || pending.revision !== confirmRevision) {
          return { status: 409, body: { error: "confirmation_mismatch" } };
        }
        const result = await this.#request("config/apply", {
          planToken: pending.token,
          confirmRevision
        });
        this.#pendingPlan = undefined;
        this.#record("config_apply", "succeeded");
        return { status: 200, body: result };
      }
      return { status: 404, body: { error: "not_found" } };
    } catch (error) {
      const code = error instanceof AdministrationResponseError ? error.code : "request_failed";
      this.#record(route.replaceAll("/", "_"), "failed", code);
      return { status: 400, body: { error: code } };
    }
  }

  #record(action: string, outcome: DashboardEvent["outcome"], code?: string): void {
    this.#events.push({ at: new Date().toISOString(), action, outcome, ...(code ? { code } : {}) });
    if (this.#events.length > MAX_EVENTS) this.#events.shift();
  }
}

export async function startDashboard(options: DashboardOptions = {}): Promise<{
  readonly url: string;
  close(): Promise<void>;
}> {
  const token = randomBytes(32).toString("base64url");
  const base = `/${token}`;
  const client = new ControlPlaneClient(options.endpoint);
  const backend = new DashboardBackend((method, params) => client.request(method, params));
  const server = createServer(async (request, response) => {
    setHeaders(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === base || url.pathname === `${base}/`) {
      send(response, 200, "text/html; charset=utf-8", dashboardHtml());
      return;
    }
    if (!url.pathname.startsWith(`${base}/api/`)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const route = url.pathname.slice(`${base}/api/`.length);
    let body: unknown;
    try {
      body = request.method === "POST" ? await readJson(request) : undefined;
    } catch {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const reply = await backend.handle(request.method ?? "", route, body);
    sendJson(response, reply.status, reply.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Dashboard did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}${base}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("JSON required");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new Error("Request too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function stringField(value: unknown, name: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
  const field = (value as Record<string, unknown>)[name];
  if (typeof field !== "string" || field.length === 0 || field.length > 4096) throw new Error(`${name} required`);
  return field;
}

function setHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, "application/json; charset=utf-8", `${JSON.stringify(body)}\n`);
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.end(body);
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Channel Bridge</title><style>
:root{color-scheme:light;font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--ink:#172033;--muted:#677085;--line:#d8dde7;--soft:#f7f9fc;--blue:#1167d8;--ok:#178a49;--warn:#b66b00;--bad:#c43c35}*{box-sizing:border-box}body{max-width:1280px;margin:0 auto;padding:28px 28px 48px;background:#fff;color:var(--ink)}header{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:20px}h1{font-size:30px;line-height:1.15;margin:0 0 4px;letter-spacing:-.025em}h2{font-size:18px;margin:22px 0 9px}.muted{color:var(--muted)}.surface{border:1px solid var(--line);border-radius:8px;background:#fff;overflow:hidden}.host{display:grid;grid-template-columns:1fr 2fr;padding:18px 22px}.host>div+div{border-left:1px solid var(--line);padding-left:28px}.status{font-weight:700;text-transform:capitalize}.status:before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px;background:currentColor}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 16px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:13px;background:var(--soft);color:#465069}tr:last-child td{border-bottom:0}.channel{display:grid;grid-template-columns:100px 1fr;gap:8px;margin:2px 0}.settings{display:grid;grid-template-columns:minmax(250px,1fr) minmax(320px,2fr);gap:24px;padding:18px}.settings>div+div{border-left:1px solid var(--line);padding-left:24px}label{display:block;font-size:13px;font-weight:650;margin:0 0 6px}input,button{font:inherit;border-radius:6px;border:1px solid #aeb6c5}input{width:100%;padding:9px 10px;margin-bottom:10px;background:#fff;color:var(--ink)}button{cursor:pointer;padding:9px 18px;background:var(--blue);border-color:var(--blue);color:#fff;font-weight:650}button:disabled{cursor:not-allowed;opacity:.45}pre{min-height:72px;margin:0 0 12px;padding:12px;background:var(--soft);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;color:#3d4658}.ready,.live,.succeeded{color:var(--ok)}.degraded,.observed{color:var(--warn)}.unavailable,.failed,.stopped{color:var(--bad)}@media(max-width:720px){body{padding:20px 14px}.host,.settings{grid-template-columns:1fr}.host>div+div,.settings>div+div{border-left:0;border-top:1px solid var(--line);padding:14px 0 0;margin-top:14px}#profiles thead{display:none}#profiles tr{display:block;padding:9px 14px}#profiles td{display:grid;grid-template-columns:92px 1fr;gap:8px;border:0;padding:4px 0}#profiles td:before{color:var(--muted);font-size:13px;font-weight:650}#profiles td:nth-child(1):before{content:"Profile"}#profiles td:nth-child(2):before{content:"Readiness"}#profiles td:nth-child(3):before{content:"Channels"}.channel{grid-template-columns:80px 1fr}.events th:nth-child(4),.events td:nth-child(4){display:none}.events th,.events td{padding:9px 7px}}
</style></head><body><header><h1>Codex Channel Bridge</h1><div class="muted">Local dashboard · content-free operational view</div></header>
<main><section><h2>Host</h2><div class="surface host" id="host">Loading…</div></section>
<section><h2>Profiles and channels</h2><div class="surface" id="profiles">Loading…</div></section>
<section><h2>Settings</h2><div class="surface settings"><div><label for="path">Config file (absolute path to config.yaml)</label><input id="path" placeholder="/absolute/path/config.yaml"><button id="plan">Plan</button></div><div><label>Last planned restart/apply (redacted)</label><pre id="planout">No plan yet.</pre><label for="confirm">Candidate revision (type the full revision to apply)</label><input id="confirm" placeholder="Complete candidate revision" disabled><button id="apply" disabled>Apply</button></div></div></section>
<section><h2>Recent dashboard events</h2><p class="muted">Status transitions and operations observed since this dashboard started.</p><div class="surface"><table class="events"><thead><tr><th>Time</th><th>Action</th><th>Outcome</th><th>Code</th></tr></thead><tbody id="events"></tbody></table></div></section></main>
<script>
const api=(path,options)=>fetch('api/'+path,{...options,headers:options?.body?{'Content-Type':'application/json'}:undefined}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error||'request_failed');return data});
const text=(value)=>value??'—';
const html=(value)=>String(text(value)).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function refresh(){try{const s=await api('status');document.querySelector('#host').innerHTML='<div><div class="status '+html(s.liveness)+'">'+html(s.liveness)+'</div><div class="muted">Codex Channel Bridge '+html(s.bridgeVersion)+'</div></div><div><div class="muted">Configuration revision</div><strong>'+html(s.configurationRevision)+'</strong></div>';document.querySelector('#profiles').innerHTML='<table><thead><tr><th>Profile</th><th>Profile readiness</th><th>Channels</th></tr></thead><tbody>'+s.profiles.map(p=>'<tr><td><strong>'+html(p.profileId)+'</strong></td><td><span class="status '+html(p.readiness)+'">'+html(p.readiness)+'</span><div class="muted">'+html(p.reason)+'</div></td><td>'+(p.channelAccounts?.map(c=>'<div class="channel"><span>'+html(c.provider)+'</span><span><b>'+html(c.channelAccountId)+'</b> · <span class="status '+html(c.readiness)+'">'+html(c.readiness)+'</span></span></div>').join('')||'—')+'</td></tr>').join('')+'</tbody></table>';const e=await api('events');document.querySelector('#events').innerHTML=e.slice().reverse().map(x=>'<tr><td>'+html(x.at)+'</td><td>'+html(x.action)+'</td><td class="'+html(x.outcome)+'">'+html(x.outcome)+'</td><td>'+html(x.code)+'</td></tr>').join('')}catch(e){document.querySelector('#host').textContent=e.message}}
document.querySelector('#plan').onclick=async()=>{try{const p=await api('config/plan',{method:'POST',body:JSON.stringify({configPath:document.querySelector('#path').value})});document.querySelector('#planout').textContent=JSON.stringify(p,null,2);document.querySelector('#confirm').disabled=false;document.querySelector('#apply').disabled=false}catch(e){document.querySelector('#planout').textContent=e.message}};
document.querySelector('#apply').onclick=async()=>{try{const r=await api('config/apply',{method:'POST',body:JSON.stringify({confirmRevision:document.querySelector('#confirm').value})});document.querySelector('#planout').textContent=JSON.stringify(r,null,2);document.querySelector('#confirm').value='';document.querySelector('#confirm').disabled=true;document.querySelector('#apply').disabled=true;refresh()}catch(e){document.querySelector('#planout').textContent=e.message}};
refresh();setInterval(refresh,3000);
</script></body></html>`;
}
