import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { STEP_FILES, proc, settle } from "./daemon-helpers.ts";
import { serve } from "./http-helpers.ts";

const TWO = proc("  - {step: b, role: pm}\n  - {step: c, role: pm}\n");

test("runs: start, list, detail by an encoded id, overrides, refusals", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  assert.deepEqual((await s.call("POST", "/api/runs", { process: "p" })).body, { run: "p#1" });
  const list = await s.call("GET", "/api/runs");
  assert.deepEqual(list.body.map((r: any) => [r.id, r.current, r.needsYou]), [["p#1", "b", false]]);
  const detail = await s.call("GET", "/api/runs/p%231");
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.plan.map((e: any) => e.id), ["b", "c"]);
  assert.ok(Array.isArray(detail.body.events));
  assert.equal((await s.call("GET", "/api/runs/nope")).status, 404);
  assert.equal((await s.call("POST", "/api/runs/p%231/pause")).status, 200);
  const again = await s.call("POST", "/api/runs/p%231/pause");
  assert.equal(again.status, 409);
  assert.match(again.body.error, /only a running run can be paused/);
  await s.call("POST", "/api/runs/p%231/resume");
  const skip = await s.call("POST", "/api/runs/p%231/entries/b/skip", {});
  assert.deepEqual([skip.status, skip.body.error], [409, "a skip needs a reason"]);
  assert.equal((await s.call("POST", "/api/runs/p%231/entries/b/done", { note: "by hand" })).status, 200);
  assert.equal((await s.call("GET", "/api/runs/p%231")).body.current, "c");
  assert.equal((await s.call("POST", "/api/runs", { process: "p" })).status, 409);
  await s.close();
});

test("agents: show and report by session; vars by session", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  await s.call("POST", "/api/runs", { process: "p" });
  await settle(s.f);
  const shown = await s.call("GET", "/api/show?session=S1");
  assert.match(shown.body.text, /Do B for p#1/);
  assert.equal((await s.call("GET", "/api/show?session=S9")).status, 409);
  const bad = await s.call("POST", "/api/report", { session: "S1", outcome: "failed" });
  assert.deepEqual([bad.status, bad.body.error], [409, "a failure needs --note"]);
  assert.equal((await s.call("POST", "/api/vars", { session: "S1", vars: { pr: "https://x/pull/1" } })).status, 200);
  assert.deepEqual(s.f.store.getRun("p#1")!.vars, { pr: "https://x/pull/1" });
  assert.equal((await s.call("POST", "/api/vars", { session: "S9", vars: {} })).status, 409);
  assert.equal((await s.call("POST", "/api/report", { session: "S1", outcome: "done" })).status, 200);
  assert.equal(s.f.store.getRun("p#1")!.current, "c");
  assert.equal((await s.call("GET", "/api/runs/p%231/entries/c/prompt")).body.text.includes("Do C"), true);
  await s.close();
});

test("definitions: list, create, stale writes, invalid writes, delete", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  const list = await s.call("GET", "/api/processes");
  assert.deepEqual(list.body.map((p: any) => [p.name, p.valid]), [["p", true]]);
  const obj = { description: "new one", cwd: "/tmp", roles: { pm: { spawn: "claude" } }, steps: [{ step: "b", role: "pm" }] };
  const created = await s.call("PUT", "/api/processes/fresh", { object: obj, mtime: null });
  assert.equal(created.status, 200);
  assert.equal((await s.call("PUT", "/api/processes/fresh", { object: obj, mtime: null })).status, 409);
  const invalid = await s.call("PUT", "/api/processes/fresh", { object: { cwd: "/tmp" }, mtime: created.body.mtime });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.body.errors.includes("description is required"));
  const got = await s.call("GET", "/api/processes/fresh");
  assert.equal(got.body.object.description, "new one");
  assert.ok(s.f.defs.processes.fresh, "saving reloads the definitions");
  assert.equal((await s.call("DELETE", `/api/processes/fresh?mtime=${got.body.mtime + 1}`)).status, 409);
  assert.equal((await s.call("DELETE", `/api/processes/fresh?mtime=${got.body.mtime}`)).status, 200);
  assert.equal((await s.call("GET", "/api/processes/fresh")).status, 404);

  assert.equal((await s.call("PUT", "/api/steps/d", { summary: "Dee", body: "Do D", mtime: null })).status, 200);
  const step = await s.call("GET", "/api/steps/d");
  assert.deepEqual([step.body.summary, step.body.body], ["Dee", "Do D"]);
  const steps = await s.call("GET", "/api/steps");
  assert.deepEqual(steps.body.find((x: any) => x.id === "b").usedBy, ["p"]);
  assert.equal((await s.call("PUT", "/api/steps/d", { mtime: step.body.mtime })).status, 400);
  await s.call("POST", "/api/runs", { process: "p" });
  assert.deepEqual((await s.call("POST", "/api/steps/d/preview", { body: "x {{run.id}}", run: "p#1" })).body, { text: "x p#1" });
  assert.equal((await s.call("POST", "/api/steps/d/preview", { body: "{{vars.q}}" })).status, 409);
  await s.close();
});

test("hooks answer at once and land as events", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  assert.deepEqual((await s.call("POST", "/agterm", { kind: "status", status: "active", session: "S7" })).body, {});
  assert.deepEqual((await s.call("POST", "/agterm", { kind: "status", status: "active" })).body, {});
  assert.deepEqual((await s.call("POST", "/claude", { event: "compacted", session: "S7" })).body, {});
  await s.f.idle();
  assert.equal(s.f.store.sessionStatus("S7"), "active");
  await s.call("POST", "/agterm", { kind: "session.closed", session: "S7" });
  await s.f.idle();
  assert.equal(s.f.store.sessionStatus("S7"), "closed");
  await s.close();
});

test("sessions, focus, plugins, events", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  s.agterm.addSession("S5");
  assert.deepEqual((await s.call("GET", "/api/sessions")).body.map((x: any) => x.id), ["S5"]);
  await s.call("POST", "/api/sessions/S5/focus");
  assert.ok(s.agterm.calls.includes("focus S5"));
  const plugins = (await s.call("GET", "/api/plugins")).body;
  assert.ok(plugins.core.includes("flow.run.done"));
  assert.deepEqual(plugins.plugins.map((p: any) => p.name), ["test"]);
  assert.equal((await s.call("POST", "/api/events", { data: {} })).status, 400);
  assert.equal((await s.call("POST", "/api/events", { type: "signal.x", data: { a: 1 } })).status, 200);
  await s.close();
});

test("static files, unknown routes, bad JSON", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  const index = await s.call("GET", "/");
  assert.equal(index.status, 200);
  assert.match(index.type, /text\/html/);
  assert.match((await s.call("GET", "/app.js")).type, /javascript/);
  assert.equal((await s.call("GET", "/../package.json")).status, 404);
  assert.equal((await s.call("GET", "/%2e%2e/package.json")).status, 404);
  assert.equal((await s.call("GET", "/api/nope")).status, 404);
  assert.equal((await s.call("POST", "/api/runs", "{not json")).status, 400);
  await s.close();
});

test("the SSE stream announces run changes", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  const ac = new AbortController();
  const res = await fetch(`${s.base}/api/stream`, { signal: ac.signal });
  const reader = res.body!.getReader();
  await s.call("POST", "/api/runs", { process: "p" });
  let text = "";
  while (!text.includes("data: runs")) text += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  await s.close();
});

function rawRequest(base: string, path: string, headers: Record<string, string>, body = ""): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: "POST", headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end(body);
  });
}

// A page in the user's browser can POST text/plain to localhost without a preflight, and a
// DNS-rebinding page reaches flowd under its own Host name; neither may drive flowd.
test("cross-site and rebinding requests are refused", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  const start = JSON.stringify({ process: "p" });
  assert.equal(await rawRequest(s.base, "/api/runs", { "content-type": "text/plain" }, start), 415);
  assert.equal(await rawRequest(s.base, "/api/runs", { "content-type": "application/json", host: "evil.example:7420" }, start), 403);
  assert.equal(await rawRequest(s.base, "/api/runs", { "content-type": "application/json", origin: "http://evil.example" }, start), 403);
  assert.deepEqual((await s.call("GET", "/api/runs")).body, []);
  assert.equal(await rawRequest(s.base, "/api/runs", { "content-type": "application/json", origin: s.base }, start), 200);
  await s.close();
});
