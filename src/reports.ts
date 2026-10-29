import { randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
};
const TOKEN = /^[0-9a-f]{32}$/;
const PATH = /^\/r\/([0-9a-f]{32})\/([A-Za-z0-9._-]+)$/;
/** a question page's own routes: its state (GET), a draft and the answer (POST) */
const ANSWER = /^\/r\/([0-9a-f]{32})\/(answer|draft)$/;
const MAX_ANSWER = 64 * 1024;

/** What flowd does with a question page's routes; null: no such question (404). */
export interface Questions {
  state(token: string): Record<string, unknown> | null;
  post(token: string, kind: "answer" | "draft", body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface ReportsOptions {
  /** where the copies live, one folder per token */
  dir: string;
  /** the public base the links start with: FLOWS_REPORTS_URL */
  url: string;
  maxBytes?: number;
  keepMs?: number;
  now?: () => number;
}

/** Agents' reports: a copy under an unguessable link, served read-only, gone after a while. */
export class Reports {
  dir: string;
  questions: Questions | undefined;
  private o: ReportsOptions;

  constructor(o: ReportsOptions) {
    this.o = o;
    this.dir = o.dir;
  }

  publish(file: string): { url: string } | { error: string } {
    if (!existsSync(file)) return { error: `no file ${file}` };
    const st = statSync(file);
    if (!st.isFile()) return { error: `${file} is not a file` };
    const max = this.o.maxBytes ?? 20 * 1024 * 1024;
    if (st.size > max) return { error: `${file} is over ${max} bytes` };
    const token = randomBytes(16).toString("hex");
    const name = basename(file).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "") || "report.html";
    mkdirSync(join(this.dir, token), { recursive: true });
    copyFileSync(file, join(this.dir, token, name));
    return { url: `${this.o.url.replace(/\/+$/, "")}/r/${token}/${name}` };
  }

  /** A page flowd wrote (a question), under a new link like any report. */
  publishText(name: string, text: string): { url: string; token: string } {
    const token = randomBytes(16).toString("hex");
    mkdirSync(join(this.dir, token), { recursive: true });
    writeFileSync(join(this.dir, token, name), text);
    return { url: `${this.o.url.replace(/\/+$/, "")}/r/${token}/${name}`, token };
  }

  /** Removes reports older than keepMs (default 30 days), by their folder's time. */
  prune(): void {
    const limit = (this.o.now ?? Date.now)() - (this.o.keepMs ?? 30 * 86_400_000);
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return; }
    for (const n of names) {
      if (!TOKEN.test(n)) continue;
      try {
        if (statSync(join(this.dir, n)).mtimeMs < limit) rmSync(join(this.dir, n), { recursive: true, force: true });
      } catch { /* gone meanwhile */ }
    }
  }

  /**
   * The whole reports listener: one path shape, read-only, and a question page's answer and draft;
   * everything else is 404.
   */
  handler(req: IncomingMessage, res: ServerResponse): void {
    const q = ANSWER.exec(req.url ?? "");
    if (q && this.questions && (req.method === "POST" || (req.method === "GET" && q[2] === "answer"))) {
      void this.question(req, res, q[1], q[2] as "answer" | "draft");
      return;
    }
    const m = PATH.exec(req.url ?? "");
    const file = m && !m[2].startsWith(".") ? join(this.dir, m[1], m[2]) : "";
    if ((req.method !== "GET" && req.method !== "HEAD") || !file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": statSync(file).size,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer", // a link in the report does not hand its URL on
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "private, max-age=300",
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  private async question(req: IncomingMessage, res: ServerResponse, token: string, kind: "answer" | "draft"): Promise<void> {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    const qs = this.questions!;
    if (!qs.state(token)) return send(404, { error: "no such question" });
    if (req.method === "GET") return send(200, qs.state(token)!);
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return send(415, { error: "send JSON" });
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_ANSWER) { req.destroy(); return send(413, { error: `an answer is at most ${MAX_ANSWER} bytes` }); }
        chunks.push(c as Buffer);
      }
    } catch { return; }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: "not JSON" }); }
    try {
      const r = await qs.post(token, kind, body);
      send(r.status, r.body);
    } catch (e) {
      send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
