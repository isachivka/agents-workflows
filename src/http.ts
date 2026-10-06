import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { CORE_EVENTS, deleteDef, readDef, splitStep, writeDef, type DefKind } from "./defs.ts";
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

function listProcesses(f: Flowd) {
  const open = f.store.openRuns();
  return fileNames(join(f.home, "processes"), ".yaml").map((name) => {
    const p = f.defs.processes[name];
    return {
      name, valid: Boolean(p), errors: f.defs.invalid[`process:${name}`] ?? [], description: p?.description ?? "",
      repeat: p?.repeat ?? false, triggers: p?.triggers ?? [], roles: p ? Object.keys(p.roles) : [],
      entries: (p?.entries ?? []).map((e) => ({ id: e.id, kind: e.kind, role: e.role ?? null, waitFor: e.waitFor?.on ?? null, detour: e.detour })),
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
  if (kind === "step") return { name, text: d.text, mtime: d.mtime, errors, ...splitStep(d.text) };
  let object: unknown = null;
  try {
    object = parse(d.text);
  } catch {
    // the YAML tab still shows the text
  }
  return { name, text: d.text, mtime: d.mtime, errors, object };
}

function putDef(f: Flowd, kind: DefKind, name: string, b: Body) {
  let text: string | null = typeof b.text === "string" ? b.text : null;
  if (text === null && kind === "process" && b.object && typeof b.object === "object") text = stringify(b.object);
  if (text === null && kind === "step" && typeof b.summary === "string" && typeof b.body === "string") {
    text = `---\nsummary: ${JSON.stringify(b.summary)}\n---\n${b.body.trim()}\n`;
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

export function makeServer(f: Flowd, uiDir: string): Server {
  const submit = async (e: Parameters<Flowd["submit"]>[0]) => refusedIfError(await f.submit(e));
  const routes: [string, RegExp, Handler][] = [
    ...defRoutes(f, "process"),
    ...defRoutes(f, "step"),
    ["POST", /^\/api\/steps\/([^/]+)\/preview$/, (_p, b) => {
      const r = f.preview(String(b.body ?? ""), typeof b.run === "string" ? b.run : undefined);
      if ("error" in r) throw new HttpError(409, r);
      return r;
    }],
    ["GET", /^\/api\/runs$/, (_p, _b, q) => f.runSummaries(q.get("all") === "1")],
    ["POST", /^\/api\/runs$/, (_p, b) => submit({ type: "run.start", data: { process: b.process, bind: b.bind ?? {} }, source: "ui" })],
    ["GET", /^\/api\/runs\/([^/]+)$/, ([id]) => {
      const d = f.runDetail(id);
      if (!d) throw new HttpError(404, { error: `no run ${id}` });
      return d;
    }],
    ["POST", /^\/api\/runs\/([^/]+)\/(pause|resume|stop)$/, ([id, verb]) => submit({ type: `run.${verb}`, run: id, data: {}, source: "ui" })],
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
    ["POST", /^\/api\/events$/, (_p, b) => {
      if (typeof b.type !== "string" || !b.type) throw new HttpError(400, { error: "type is required" });
      return submit({ type: b.type, run: b.run || undefined, entry: b.entry || undefined, outcome: b.outcome || undefined, data: b.data ?? {}, source: b.source ?? "cli" });
    }],
    ["GET", /^\/api\/sessions$/, () => f.agterm.tree()],
    ["POST", /^\/api\/sessions\/([^/]+)\/focus$/, async ([id]) => {
      await f.agterm.focus(id);
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
        void f.submit({ type: b.kind === "session.closed" ? "agterm.closed" : "agterm.status", data: { session, status: b.status }, source: "agterm" });
      }
      return {};
    }],
    ["POST", /^\/claude$/, (_p, b) => {
      if (b.event === "compacted" && typeof b.session === "string" && b.session) {
        void f.submit({ type: "claude.compacted", data: { session: b.session }, source: "claude" });
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
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || (origin && origin !== `http://${host}`)) {
      return send(res, 403, { error: "flowd only answers its own pages and local clients" });
    }
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
