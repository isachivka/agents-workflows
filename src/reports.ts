import { randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
};
const TOKEN = /^[0-9a-f]{32}$/;
const PATH = /^\/r\/([0-9a-f]{32})\/([A-Za-z0-9._-]+)$/;

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

  /** The whole reports listener: one path shape, read-only; everything else is 404. */
  handler(req: IncomingMessage, res: ServerResponse): void {
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
}
