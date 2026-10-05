import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, subscriptionKey, type Plugin, type Watch } from "../src/plugins.ts";
import type { FlowEvent } from "../src/types.ts";

const host = (extra: Partial<ConstructorParameters<typeof PluginHost>[0]> = {}) => {
  const sunk: FlowEvent[] = [];
  const h = new PluginHost({ dirs: [], config: { demo: { k: 1 } }, sink: (e) => sunk.push(e), log: () => {}, retryBaseMs: 10, ...extra });
  return { h, sunk };
};
const w = (type: string, entry = "e1"): Watch => ({ run: "p#1", entry, type, with: {}, cwd: "/repo", vars: {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("event types and actions are namespaced; core events always exist", () => {
  const { h } = host();
  h.add({ name: "demo", events: ["ping"], actions: { post: () => {} } });
  assert.ok(h.eventTypes().has("demo.ping"));
  assert.ok(h.eventTypes().has("flow.run.done"));
  assert.deepEqual([...h.actionNames()], ["demo.post"]);
});

test("emit prefixes the type, carries run/entry, and sets the source", () => {
  const { h, sunk } = host();
  let ctxConfig: unknown;
  h.add({ name: "demo", start(ctx) { ctxConfig = ctx.config; ctx.emit({ type: "ping", data: { a: 1 }, run: "p#1", entry: "e1", outcome: "done" }); } });
  h.startAll();
  assert.deepEqual(ctxConfig, { k: 1 });
  assert.deepEqual(sunk, [{ type: "demo.ping", data: { a: 1 }, outcome: "done", run: "p#1", entry: "e1", source: "demo" }]);
});

test("watch calls the plugin, unwatch stops it, re-watching replaces", () => {
  const { h } = host();
  const log: string[] = [];
  h.add({ name: "demo", watch: (x) => { log.push(`watch ${x.entry}`); return () => log.push(`stop ${x.entry}`); } });
  h.watch(w("demo.ping"));
  h.watch(w("demo.ping"));
  h.unwatch("p#1", "e1");
  h.unwatch("p#1", "e1");
  assert.deepEqual(log, ["watch e1", "stop e1", "watch e1", "stop e1"]);
});

test("a throwing watch is reported and retried with backoff", async () => {
  const { h } = host();
  let calls = 0;
  h.add({ name: "demo", watch: () => { if (++calls === 1) throw new Error("gh down"); } });
  h.watch(w("demo.ping"));
  assert.equal(h.status()[0].watches[0].error, "gh down");
  assert.equal(h.status()[0].lastError, "gh down");
  await sleep(40);
  assert.equal(calls, 2);
  assert.equal(h.status()[0].watches[0].error, null);
});

test("an unwatch cancels a pending retry", async () => {
  const { h } = host();
  let calls = 0;
  h.add({ name: "demo", watch: () => { calls++; throw new Error("x"); } });
  h.watch(w("demo.ping"));
  h.unwatch("p#1", "e1");
  await sleep(40);
  assert.equal(calls, 1);
});

test("flow.* and signal.* waits need no plugin", () => {
  const { h } = host();
  h.watch(w("signal.deploy"));
  h.watch(w("flow.run.done", "e2"));
  h.stopAll();
});

test("actions run, unknown ones are refused, failures are recorded", async () => {
  const { h } = host();
  h.add({ name: "demo", actions: { post: (args) => `posted ${args.m}`, boom: () => { throw new Error("nope"); } } });
  assert.equal(await h.runAction("demo.post", { m: "hi" }), "posted hi");
  await assert.rejects(h.runAction("demo.nothing", {}), /no action demo\.nothing/);
  await assert.rejects(h.runAction("demo.boom", {}), /nope/);
  assert.equal(h.status()[0].lastError, "nope");
});

test("a throwing start is recorded, not fatal", () => {
  const { h } = host();
  h.add({ name: "demo", start() { throw new Error("no token"); } });
  h.startAll();
  assert.equal(h.status()[0].lastError, "no token");
});

test("load reads .ts plugins; later directories win; bad files are reported", async () => {
  const a = mkdtempSync(join(tmpdir(), "flows-pa-"));
  const b = mkdtempSync(join(tmpdir(), "flows-pb-"));
  writeFileSync(join(a, "demo.ts"), `export default { name: "demo", events: ["one"] };\n`);
  writeFileSync(join(b, "demo.ts"), `export default { name: "demo", events: ["two"] };\n`);
  writeFileSync(join(b, "broken.ts"), `export default 42;\n`);
  writeFileSync(join(b, "reserved.ts"), `export default { name: "flow" };\n`);
  const { h } = host({ dirs: [a, b, join(a, "missing")] });
  await h.load();
  assert.ok(h.eventTypes().has("demo.two"));
  assert.ok(!h.eventTypes().has("demo.one"));
  const st = h.status();
  assert.match(st.find((p) => p.name === "broken")!.lastError!, /default export/);
  assert.match(st.find((p) => p.name === "reserved")!.lastError!, /reserved/);
});

test("plugin type is a structural contract", () => {
  const p: Plugin = { name: "x" };
  assert.equal(p.name, "x");
});

const sub = (type: string, withArgs = {}): Watch => ({ type, with: withArgs, cwd: "/repo", vars: {}, processes: ["p"] });

test("a run-less watch is a subscription keyed by type, cwd and with", () => {
  const { h } = host();
  const log: string[] = [];
  h.add({ name: "demo", watch: (x) => { log.push(`watch ${x.run ?? "sub"}`); return () => log.push("stop"); } });
  h.watch(sub("demo.ping", { b: 1, a: 2 }));
  const k = subscriptionKey(sub("demo.ping", { a: 2, b: 1 }));
  assert.deepEqual(h.subscriptionKeys(), [k]);
  assert.equal(h.subscription(k)?.type, "demo.ping");
  h.unsubscribe(k);
  assert.deepEqual(h.subscriptionKeys(), []);
  assert.deepEqual(log, ["watch sub", "stop"]);
});

test("a subscription's emit carries its key, so only its processes start; status shows who asked", () => {
  const { h, sunk } = host();
  h.add({ name: "demo", watch: (_x, ctx) => { ctx.emit({ type: "ping", data: { a: 1 } }); } });
  h.watch(sub("demo.ping"));
  assert.deepEqual(sunk, [{ type: "demo.ping", data: { a: 1 }, outcome: undefined, run: undefined, entry: undefined, source: "demo", subscription: subscriptionKey(sub("demo.ping")) }]);
  assert.deepEqual(h.status()[0].watches, [{ run: null, entry: null, type: "demo.ping", processes: ["p"], error: null }]);
});

test("a throwing subscription is reported and retried like a wait", async () => {
  const { h } = host();
  let calls = 0;
  h.add({ name: "demo", watch: () => { if (++calls === 1) throw new Error("needs with.repo"); } });
  h.watch(sub("demo.ping"));
  assert.equal(h.status()[0].watches[0].error, "needs with.repo");
  await sleep(40);
  assert.equal(calls, 2);
});

test("an error a running subscription reports later marks that subscription", async () => {
  const { h } = host();
  h.add({ name: "demo", watch: (x, ctx) => { setTimeout(() => ctx.error(new Error("poll failed"), x), 1); } });
  h.watch(sub("demo.ping"));
  await sleep(10);
  assert.equal(h.status()[0].watches[0].error, "poll failed");
});

test("ctx.error(null, w) clears a watch's error once it works again", async () => {
  const { h } = host();
  h.add({ name: "demo", watch: (x, ctx) => { setTimeout(() => ctx.error(new Error("blip"), x), 1); setTimeout(() => ctx.error(null, x), 5); } });
  h.watch(sub("demo.ping"));
  await sleep(3);
  assert.equal(h.status()[0].watches[0].error, "blip");
  await sleep(10);
  assert.equal(h.status()[0].watches[0].error, null);
});
