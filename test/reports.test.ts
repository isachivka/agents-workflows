import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Reports } from "../src/reports.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "flows-reports-"));
const DAY = 86_400_000;

test("publish copies the file under a 128-bit token with a clean name and returns its link", () => {
  const src = tmp();
  const file = join(src, "plan for X (v2).html");
  writeFileSync(file, "<p>plan</p>");
  const r = new Reports({ dir: join(tmp(), "reports"), url: "https://reports.example.net/" });
  const out = r.publish(file);
  assert.ok("url" in out, JSON.stringify(out));
  const m = /^https:\/\/reports\.example\.net\/r\/([0-9a-f]{32})\/plan-for-X--v2-\.html$/.exec(out.url);
  assert.ok(m, out.url);
  assert.equal(readFileSync(join(r.dir, m[1], "plan-for-X--v2-.html"), "utf8"), "<p>plan</p>");
  assert.notEqual((r.publish(file) as { url: string }).url, out.url); // each publish is a new link
});

test("publish refuses a missing file, a directory and a file over the limit", () => {
  const src = tmp();
  const r = new Reports({ dir: join(tmp(), "reports"), url: "https://x", maxBytes: 4 });
  assert.deepEqual(r.publish(join(src, "nope.html")), { error: `no file ${join(src, "nope.html")}` });
  assert.deepEqual(r.publish(src), { error: `${src} is not a file` });
  writeFileSync(join(src, "big.html"), "12345");
  assert.deepEqual(r.publish(join(src, "big.html")), { error: `${join(src, "big.html")} is over 4 bytes` });
});

test("the server answers a report's path with the file and its headers, and 404 to anything else", async () => {
  const src = tmp();
  writeFileSync(join(src, "r.html"), "<p>hi</p>");
  const r = new Reports({ dir: join(tmp(), "reports"), url: "https://x" });
  const path = new URL((r.publish(join(src, "r.html")) as { url: string }).url).pathname;
  const server = createServer((req, res) => r.handler(req, res));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const got = await fetch(base + path);
  assert.equal(got.status, 200);
  assert.equal(await got.text(), "<p>hi</p>");
  assert.equal(got.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.equal(got.headers.get("referrer-policy"), "no-referrer");
  assert.equal(got.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(got.headers.get("cache-control"), "private, max-age=300");
  const head = await fetch(base + path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const token = path.split("/")[2];
  for (const [method, p] of [["GET", "/"], ["GET", "/api/runs"], ["GET", `/r/${token.slice(1)}/r.html`], ["GET", `/r/${token}/..%2Fx.html`],
    ["GET", `/r/${token}/other.html`], ["GET", `/r/${token}`], ["POST", path]] as const) {
    const res = await fetch(base + p, { method });
    assert.equal(res.status, 404, `${method} ${p}`);
    await res.text();
  }
});

test("prune deletes reports older than the limit and keeps newer ones", () => {
  const src = tmp();
  writeFileSync(join(src, "a.html"), "a");
  const t = Date.now();
  const r = new Reports({ dir: join(tmp(), "reports"), url: "https://x", keepMs: 30 * DAY, now: () => t });
  const tok = (u: { url: string } | { error: string }) => new URL((u as { url: string }).url).pathname.split("/")[2];
  const old = tok(r.publish(join(src, "a.html")));
  const fresh = tok(r.publish(join(src, "a.html")));
  const past = (Date.now() - 31 * DAY) / 1000;
  utimesSync(join(r.dir, old), past, past);
  mkdirSync(join(r.dir, "stray"), { recursive: true }); // not a report: left alone
  r.prune();
  assert.equal(existsSync(join(r.dir, old)), false);
  assert.equal(existsSync(join(r.dir, fresh)), true);
  assert.equal(existsSync(join(r.dir, "stray")), true);
});
