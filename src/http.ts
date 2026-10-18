import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { CORE_EVENTS, deleteDef, readDef, splitStep, writeDef, type DefKind } from "./defs.ts";
import { agentOf } from "./skills.ts";
import type { Flowd, Result } from "./daemon.ts";

class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// request bodies are untyped JSON
type Body = Record<string, any>;
type Handler = (params: string[], body: Body, query: URLSearchParams, res: ServerResponse) => unknown;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const refusedIfError = (r: Result): Result => {
  if (r.error) throw new HttpError(409, { error: r.error });
  return r;
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, { error: "the body must be a JSON object" });
}

const fileNames = (dir: string, ext: string) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ext)).map((n) => basename(n, ext)).sort() : [];

const tilde = (p: string) => (p.startsWith(homedir() + "/") ? `~${p.slice(homedir().length)}` : p);
const defPath = (f: Flowd, kind: DefKind, name: string) =>
  tilde(join(f.home, kind === "process" ? "processes" : "steps", `${name}${kind === "process" ? ".yaml" : ".md"}`));

function listProcesses(f: Flowd) {
  const open = f.store.openRuns();
  return fileNames(join(f.home, "processes"), ".yaml").map((name) => {
    const p = f.defs.processes[name];
    return {
      name, valid: Boolean(p), errors: f.defs.invalid[`process:${name}`] ?? [], description: p?.description ?? "",
      repeat: p?.repeat ?? false, maxRuns: p?.maxRuns ?? 1, cwd: p?.cwd ?? "",
      triggers: p?.triggers ?? [], roles: p ? Object.keys(p.roles) : [],
      path: defPath(f, "process", name), workspace: p?.workspace ?? name, terminal: p?.terminal ?? "agterm",
      roleDefs: p ? Object.entries(p.roles).map(([n, r]) => ({ name: n, agent: agentOf(r.spawn), beside: r.beside ?? null, cwd: r.cwd ?? null })) : [],
      entries: (p?.entries ?? []).map((e) => ({
        id: e.id, kind: e.kind, role: e.role ?? null, waitFor: e.waitFor?.on ?? null, detour: e.detour,
        step: e.step ?? null, summary: e.step ? f.defs.steps[e.step]?.summary ?? null : null,
        do: e.do ?? null, onFail: e.onFail, after: e.after ?? null, waitMs: e.delayMs ?? null, sh: e.sh ?? null,
        timeoutMs: e.timeoutMs ?? null, retries: e.retries, hold: e.hold ?? null, with: e.with,
        waitWith: e.waitFor?.with ?? null, waitWhere: e.waitFor?.where ?? null, text: e.text ?? null, cwd: e.cwd ?? null,
        skills: e.step ? f.defs.steps[e.step]?.skills ?? [] : [],
      })),
      openRuns: open.filter((r) => r.process === name).map((r) => r.id),
      triggerErrors: f.triggerErrors(name),
    };
  });
}

function listSteps(f: Flowd) {
  const procs = Object.values(f.defs.processes);
  return fileNames(join(f.home, "steps"), ".md").map((id) => ({
    id, valid: Boolean(f.defs.steps[id]), errors: f.defs.invalid[`step:${id}`] ?? [], summary: f.defs.steps[id]?.summary ?? "",
    usedBy: procs.filter((p) => p.entries.some((e) => e.step === id)).map((p) => p.name),
  }));
}

function getDef(f: Flowd, kind: DefKind, name: string) {
  const d = readDef(f.home, kind, name);
  if (!d) throw new HttpError(404, { error: `no ${kind} ${name}` });
  const errors = f.defs.invalid[`${kind}:${name}`] ?? [];
  if (kind === "step") return { name, path: defPath(f, kind, name), text: d.text, mtime: d.mtime, errors, ...splitStep(d.text) };
  let object: unknown = null;
  try {
    object = parse(d.text);
  } catch {
    // the YAML tab still shows the text
  }
  return { name, path: defPath(f, kind, name), text: d.text, mtime: d.mtime, errors, object };
}

function putDef(f: Flowd, kind: DefKind, name: string, b: Body) {
  let text: string | null = typeof b.text === "string" ? b.text : null;
  if (text === null && kind === "process" && b.object && typeof b.object === "object") text = stringify(b.object);
  if (text === null && kind === "step" && typeof b.summary === "string" && typeof b.body === "string") {
    const skills = Array.isArray(b.skills) && b.skills.length ? `skills: [${b.skills.map((x: unknown) => JSON.stringify(String(x))).join(", ")}]\n` : "";
    text = `---\nsummary: ${JSON.stringify(b.summary)}\n${skills}---\n${b.body.trim()}\n`;
  }
  if (text === null) throw new HttpError(400, { error: "send text, or object (process), or summary and body (step)" });
  const r = writeDef(f.home, kind, name, text, typeof b.mtime === "number" ? b.mtime : null, f.defCtx());
  if (!r.ok) throw new HttpError(r.status, { errors: r.errors });
  f.reloadDefs();
  return { mtime: r.mtime };
}

function defRoutes(f: Flowd, kind: DefKind): [string, RegExp, Handler][] {
  const base = kind === "process" ? "processes" : "steps";
  const one = new RegExp(`^/api/${base}/([^/]+)$`);
  return [
    ["GET", new RegExp(`^/api/${base}$`), () => (kind === "process" ? listProcesses(f) : listSteps(f))],
    ["GET", one, ([name]) => getDef(f, kind, name)],
    ["PUT", one, ([name], b) => putDef(f, kind, name, b)],
    ["DELETE", one, ([name], _b, q) => {
      const r = deleteDef(f.home, kind, name, q.has("mtime") ? Number(q.get("mtime")) : null);
      if (!r.ok) throw new HttpError(r.status, { errors: r.errors });
      f.reloadDefs();
      return {};
    }],
  ];
}

const SESSION = "flows_session";
const SESSION_DAYS = 30;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function page(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>flows — log in</title><style>:root{color-scheme:light dark}body{font:17px system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;text-align:center}main{padding:24px;max-width:420px}h1{font-size:24px}</style>
<main><h1>flows</h1>${body}</main></html>`);
}

/**
 * The UI through FLOWD_PUBLIC_URL: flowd has no login of its own, so there it asks the active login
 * plugin for one and keeps a session. Answers the request itself (the login page, the callback, a
 * refusal) and returns true, or returns false for a request with a valid session.
 */
async function publicGate(f: Flowd, req: IncomingMessage, res: ServerResponse, url: URL, pub: URL | undefined): Promise<boolean> {
  const l = pub ? f.plugins.login() : { error: "FLOWD_PUBLIC_URL is not set, so a login has nowhere to come back to" };
  const active = l && "login" in l ? l : undefined;
  if (req.method === "GET" && url.pathname === "/login") {
    page(res, 200, active ? active.login.page({ callback: `${pub!.origin}/auth/${active.name}` }, active.ctx)
      : `<p>no login is set up${l && "error" in l ? `: ${esc(l.error)}` : ""}. Add a login plugin's section to plugins.yaml (docs/plugins.md#logins) and restart flowd.</p>`);
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/auth/")) {
    if (!active || url.pathname !== `/auth/${active.name}`) { send(res, 404, { error: "not found" }); return true; }
    const who = active.login.verify(Object.fromEntries(url.searchParams), active.ctx);
    if ("error" in who) { page(res, 403, `<p>Not logged in: ${esc(who.error)}</p><p><a href="/login">Try again</a></p>`); return true; }
    const token = randomBytes(32).toString("base64url");
    f.store.addLogin(sha(token), who.user, who.name, Date.now() + SESSION_DAYS * 86_400_000);
    res.writeHead(302, { location: "/", "cache-control": "no-store",
      // Lax, not Strict: this answer ends a navigation that came from the provider's site
      "set-cookie": `${SESSION}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86_400}` });
    res.end();
    return true;
  }
  const token = cookie(req, SESSION);
  const session = token ? f.store.login(sha(token)) : null;
  if (req.method === "POST" && url.pathname === "/logout") {
    if (token) f.store.dropLogin(sha(token));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": `${SESSION}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
    res.end("{}");
    return true;
  }
  if (session) return false;
  if (url.pathname.startsWith("/api/")) send(res, 401, { error: "log in at /login" });
  else { res.writeHead(302, { location: "/login", "cache-control": "no-store" }); res.end(); }
  return true;
}

function serveStatic(uiDir: string, pathname: string, res: ServerResponse): void {
  const root = resolve(uiDir);
  const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    send(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(readFileSync(file));
}

function stream(f: Flowd, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const off = f.on((what) => res.write(`data: ${what}\n\n`));
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  req.on("close", () => {
    off();
    clearInterval(keepAlive);
  });
}

export function makeServer(f: Flowd, uiDir: string, opts: { lan?: boolean; publicUrl?: string; publicFrom?: string[] } = {}): Server {
  const pub = opts.publicUrl ? new URL(opts.publicUrl) : undefined;
  const submit = async (e: Parameters<Flowd["submit"]>[0]) => refusedIfError(await f.submit(e));
  const routes: [string, RegExp, Handler][] = [
    ...defRoutes(f, "process"),
    ...defRoutes(f, "step"),
    ["POST", /^\/api\/steps\/([^/]+)\/translate$/, async ([id], b) => {
      const r = await f.translateStep(id, b.lang);
      if ("error" in r) throw new HttpError(r.status, { error: r.error });
      return r;
    }],
    ["POST", /^\/api\/steps\/([^/]+)\/preview$/, (_p, b) => {
      const r = f.preview(String(b.body ?? ""), typeof b.run === "string" ? b.run : undefined);
      if ("error" in r) throw new HttpError(409, r);
      return r;
    }],
    ["GET", /^\/api\/runs$/, (_p, _b, q) => f.runSummaries(q.get("all") === "1")],
    ["POST", /^\/api\/runs$/, (_p, b) => {
      if (b.inner !== undefined && (!Array.isArray(b.inner) || !b.inner.every((x: unknown) => typeof x === "string" && x))) {
        throw new HttpError(400, { error: "inner must be a list of process names (or none)" });
      }
      return submit({ type: "run.start", data: { process: b.process, bind: b.bind ?? {}, vars: b.vars ?? {}, inner: b.inner }, source: "ui" });
    }],
    ["POST", /^\/api\/skip$/, (_p, b) => submit({ type: "entry.skip", run: typeof b.run === "string" && b.run ? b.run : undefined, data: { session: b.session, note: b.note }, source: "cli" })],
    ["GET", /^\/api\/runs\/([^/]+)$/, ([id]) => {
      const d = f.runDetail(id);
      if (!d) throw new HttpError(404, { error: `no run ${id}` });
      return d;
    }],
    ["POST", /^\/api\/runs\/([^/]+)\/(pause|resume|stop|ping)$/, ([id, verb]) => submit({ type: `run.${verb}`, run: id, data: {}, source: "ui" })],
    ["POST", /^\/api\/runs\/([^/]+)\/nest$/, ([id], b) => submit({ type: "run.nest", run: id, data: { process: String(b.process ?? ""), ui: true }, source: "ui" })],
    ["POST", /^\/api\/runs\/([^/]+)\/vars$/, ([id], b) => submit({ type: "run.set", run: id, data: { vars: b.vars ?? {} }, source: "ui" })],
    ["POST", /^\/api\/runs\/([^/]+)\/entries\/([^/]+)\/(done|failed|skip|retry|goto)$/, ([id, entry, verb], b) =>
      submit(verb === "done" || verb === "failed"
        ? { type: "entry.report", data: { run: id, entry, outcome: verb, note: b.note, evidence: b.evidence, by: "human" }, source: "ui" }
        : { type: `entry.${verb}`, run: id, entry, data: { note: b.note }, source: "ui" })],
    ["GET", /^\/api\/runs\/([^/]+)\/entries\/([^/]+)\/prompt$/, ([id, entry]) => {
      const r = f.show({ run: id, entry });
      if ("error" in r) throw new HttpError(409, r);
      return r;
    }],
    ["POST", /^\/api\/runs\/([^/]+)\/roles\/([^/]+)\/restore$/, async ([id, role]) => {
      const r = await f.restoreSession(id, role);
      if ("error" in r) throw new HttpError(409, r);
      return r;
    }],
    ["POST", /^\/api\/runs\/([^/]+)\/roles\/([^/]+)\/(rebind|respawn)$/, ([id, role, verb], b) =>
      submit(verb === "rebind"
        ? { type: "role.bind", run: id, data: { role, session: String(b.session ?? ""), by: "human" }, source: "ui" }
        : { type: "role.respawn", run: id, data: { role }, source: "ui" })],
    ["GET", /^\/api\/show$/, (_p, _b, q) => {
      const r = f.show({ session: q.get("session") ?? undefined, run: q.get("run") ?? undefined, entry: q.get("entry") ?? undefined });
      if ("error" in r) throw new HttpError(409, r);
      return r;
    }],
    ["POST", /^\/api\/report$/, (_p, b) => submit({
      type: "entry.report",
      data: { session: b.session, run: b.run, entry: b.entry, outcome: b.outcome, note: b.note, evidence: b.evidence, by: b.human ? "human" : "agent" },
      source: "cli",
    })],
    ["POST", /^\/api\/wait$/, (_p, b) => submit({
      type: "entry.wait",
      data: { session: b.session, run: b.run, entry: b.entry, note: b.note, human: b.human === true },
      source: "cli",
    })],
    ["POST", /^\/api\/vars$/, (_p, b) => {
      let run = typeof b.run === "string" ? b.run : "";
      if (!run) {
        const hit = typeof b.session === "string" && b.session ? f.store.runBySession(b.session) : null;
        if (!hit) throw new HttpError(409, { error: "no open run is bound to this session" });
        run = hit.run.id;
      }
      return submit({ type: "run.set", run, data: { vars: b.vars ?? {} }, source: "cli" });
    }],
    ["POST", /^\/api\/publish$/, (_p, b) => {
      if (typeof b.file !== "string" || !b.file) throw new HttpError(400, { error: "file is required" });
      const r = f.publish(b.file);
      if ("error" in r) throw new HttpError(409, r);
      return r;
    }],
    ["POST", /^\/api\/say$/, async (_p, b) => {
      if (typeof b.text !== "string" || !b.text.trim()) throw new HttpError(400, { error: "text is required" });
      if (b.file !== undefined && typeof b.file !== "string") throw new HttpError(400, { error: "file must be a path" });
      const r = await f.say({ session: typeof b.session === "string" ? b.session : undefined, run: typeof b.run === "string" && b.run ? b.run : undefined, text: b.text, file: b.file || undefined });
      if (r.error) throw new HttpError(409, r);
      return {};
    }],
    ["POST", /^\/api\/events$/, (_p, b) => {
      if (typeof b.type !== "string" || !b.type) throw new HttpError(400, { error: "type is required" });
      return submit({ type: b.type, run: b.run || undefined, entry: b.entry || undefined, outcome: b.outcome || undefined, data: b.data ?? {}, source: b.source ?? "cli" });
    }],
    ["GET", /^\/api\/sessions$/, () => f.sessions()],
    ["POST", /^\/api\/sessions\/([^/]+)\/focus$/, async ([id]) => {
      await f.termOf(id).focus(id);
      return {};
    }],
    ["GET", /^\/api\/plugins$/, () => ({ core: CORE_EVENTS, plugins: f.plugins.status() })],
    ["POST", /^\/api\/restart$/, (_p, _b, _q, res) => {
      res.on("finish", () => setTimeout(() => process.exit(0), 50));
      return {};
    }],
    ["POST", /^\/agterm$/, (_p, b) => {
      const session = typeof b.session === "string" ? b.session : "";
      if (session) {
        void f.submit({ type: b.kind === "session.closed" ? "agterm.closed" : "agterm.status", data: { session, status: b.status, pane: b.pane }, source: "agterm" });
      }
      return {};
    }],
    ["POST", /^\/claude$/, (_p, b) => {
      if (typeof b.session !== "string" || !b.session) return {};
      if (b.event === "compacted") void f.submit({ type: "claude.compacted", data: { session: b.session }, source: "claude" });
      // PostToolUse fires on every tool call: an active that changes nothing is not worth an event
      else if (b.event === "active" && f.store.sessionStatus(b.session) === "active") return {};
      else if (["start", "active", "completed", "blocked", "idle"].includes(b.event)) {
        void f.submit({ type: "claude.status", data: { session: b.session, event: b.event, claude: b.claude, source: b.source }, source: "claude" });
      }
      return {};
    }],
  ];

  return createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(res, 400, { error: "bad request target" }); // e.g. //[ — must not crash flowd
    }
    // No auth, so no browser page but flowd's own: a foreign Host is DNS rebinding, a foreign
    // Origin is a cross-site request, and JSON-only bodies force a preflight flowd never answers.
    const host = req.headers.host ?? "";
    const origin = req.headers.origin;
    // On the LAN a phone asks by the Mac's IP; an IP literal cannot be rebound, a name can.
    const ownHost = opts.lan ? /^(127\.0\.0\.1|localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/ : /^(127\.0\.0\.1|localhost)(:\d+)?$/;
    // From outside: by the public name, or from the reverse proxy's address (FLOWD_PUBLIC_FROM) — a
    // proxy that rewrites Host to this machine's IP (a Keenetic does, and drops Origin) looks local otherwise.
    const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const outside = Boolean(pub && host === pub.host) || Boolean(opts.publicFrom?.includes(remote));
    const own = outside
      ? !origin || origin === pub?.origin
      : ownHost.test(host) && (!origin || origin === `http://${host}`);
    if (!own) {
      return send(res, 403, { error: "flowd only answers its own pages and local clients" });
    }
    if (outside && await publicGate(f, req, res, url, pub)) return;
    try {
      if (req.method === "GET" && url.pathname === "/api/stream") return stream(f, req, res);
      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname);
        if (!m || method !== req.method) continue;
        if (method !== "GET" && method !== "DELETE" && !/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
          throw new HttpError(415, { error: "send the body as application/json" });
        }
        const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);
        const out = await handler(m.slice(1).map(decodeURIComponent), body, url.searchParams, res);
        return send(res, 200, out ?? {});
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(uiDir, url.pathname, res);
      send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, e.body);
      else send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
