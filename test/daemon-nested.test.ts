import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { STEP_FILES, makeHome, proc, settle, startFlowd } from "./daemon-helpers.ts";

const OUTER = proc("  - {step: b, role: pm}\n  - {inner: true, role: pm}\n  - {step: c, role: pm}\n", "", "outer");
const MID = proc("  - {inner: true, role: pm}\n  - {step: c, role: pm}\n", "", "mid");
const LEAF = proc("  - {step: b, role: pm}\n", "", "leaf");
const HOME = { ...STEP_FILES, ...OUTER, ...MID, ...LEAF };

const start = (process: string, bind: Record<string, string>, extra: Record<string, unknown> = {}) =>
  ({ type: "run.start", data: { process, bind, ...extra }, source: "test" });
const status = (session: string, s: string) => ({ type: "agterm.status", data: { session, status: s }, source: "agterm" });
const done = (session: string) => ({ type: "entry.report", data: { session, outcome: "done" }, source: "cli" });

/** outer#1 on S1, its first step b closed: it stands on inner */
async function outerOnInner(files: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const home = makeHome({ ...HOME, ...files });
  const t = await startFlowd(home);
  t.agterm.addSession("S1", "S2");
  assert.deepEqual(await t.f.submit(start("outer", { pm: "S1" }, extra)), { run: "outer#1" });
  await settle(t.f);
  await t.f.submit(status("S1", "active"));
  await t.f.submit(done("S1"));
  await settle(t.f);
  return { ...t, home };
}

test("--inner starts each process of the chain in the inner of the one before, on the same agent", async () => {
  const { f } = await outerOnInner({}, { inner: ["mid", "leaf"], vars: { issue: "K-1" } });
  const [outer, mid, leaf] = ["outer#1", "mid#1", "leaf#1"].map((id) => f.store.getRun(id)!);
  assert.deepEqual([outer.entries.inner.status, outer.entries.inner.child], ["waiting", "mid#1"]);
  assert.deepEqual([mid.parent?.run, mid.entries.inner.child, mid.roles.pm], ["outer#1", "leaf#1", "S1"]);
  assert.deepEqual([leaf.parent, leaf.roles.pm, leaf.current], [{ run: "mid#1", entry: "inner", vars: { issue: "K-1" } }, "S1", "b"]);
  assert.equal(leaf.vars.issue, "K-1");
  assert.equal(f.store.runBySession("S1")?.run.id, "leaf#1");
  await f.close();
});

test("a chain that cannot be placed is refused before anything starts", async () => {
  const t = await startFlowd(makeHome({ ...HOME, ...proc("  - {inner: true, role: pm}\n", "repeat: true\n", "loop") }));
  const err = async (process: string, inner: string[]) => (await t.f.submit(start(process, {}, { inner }))).error;
  assert.equal(await err("leaf", ["mid"]), "leaf has no inner step, so mid has nowhere to go");
  assert.equal(await err("outer", ["leaf", "mid"]), "leaf has no inner step, so mid has nowhere to go");
  assert.equal(await err("outer", ["none", "leaf"]), "none must be the last of --inner");
  assert.equal(await err("outer", ["loop"]), "loop repeats (repeat: true), so it never ends and cannot run nested");
  assert.match((await err("outer", ["nope"]))!, /^no valid process nope/);
  assert.deepEqual(t.f.store.openRuns(), []);
  await t.f.close();
});

test("a start on a busy agent waits for inner; there it becomes the nested run with the parent's vars", async () => {
  const t = await startFlowd(makeHome(HOME));
  t.agterm.addSession("S1");
  await t.f.submit(start("outer", { pm: "S1" }, { vars: { issue: "K-1" } }));
  await settle(t.f);
  assert.equal((await t.f.submit(start("leaf", { pm: "S1" }))).error,
    "pm is busy with outer#1 at step b; a nested process can start when it reaches inner");
  await t.f.submit(status("S1", "active"));
  await t.f.submit(done("S1"));
  await settle(t.f);
  assert.deepEqual(await t.f.submit(start("leaf", { pm: "S1" }, { vars: { pr: "u" } })), { run: "leaf#1" });
  const leaf = t.f.store.getRun("leaf#1")!;
  assert.deepEqual([leaf.parent?.run, leaf.vars.issue, leaf.vars.pr], ["outer#1", "K-1", "u"]);
  assert.equal(t.f.store.getRun("outer#1")!.entries.inner.child, "leaf#1");
  // leaf has no inner: nothing can ever nest in it
  assert.equal((await t.f.submit(start("mid", { pm: "S1" }))).error, "session S1 is already bound to leaf#1");
  await t.f.close();
});

test("the nested run takes the agent in the role named like inner's, else its only role", async () => {
  const solo = { "processes/solo.yaml": "description: d\ncwd: /tmp\nroles: {dev: {spawn: claude}}\nsteps:\n  - {step: b, role: dev}\n" };
  const pair = { "processes/pair.yaml": "description: d\ncwd: /tmp\nroles: {a: {spawn: claude}, b: {spawn: claude}}\nsteps:\n  - {step: b, role: a}\n" };
  const one = await outerOnInner({ ...solo, ...pair }, { inner: ["solo"] });
  assert.equal(one.f.store.getRun("solo#1")!.roles.dev, "S1");
  await one.f.close();
  const two = await outerOnInner({ ...solo, ...pair }, { inner: ["pair"] });
  const outer = two.f.store.getRun("outer#1")!;
  assert.deepEqual([outer.status, outer.reason], ["needs-human", "inner failed: pair has roles a, b; none is pm"]);
  assert.equal(two.f.store.getRun("pair#1"), null);
  await two.f.close();
});

test("a nested run may not clear the borrowed agent's context", async () => {
  const wipe = proc("  - {do: clear, role: pm}\n  - {step: b, role: pm}\n", "", "wipe");
  const t = await outerOnInner(wipe);
  assert.equal((await t.f.submit(start("wipe", { pm: "S1" }))).error, "wipe clears pm's context, which outer#1 still needs; use compact");
  await t.f.close();
});

test("a nested run over its max_runs queues, attached to its parent", async () => {
  const t = await outerOnInner();
  assert.deepEqual(await t.f.submit(start("leaf", { pm: "S2" })), { run: "leaf#1" });
  const r = await t.f.submit(start("leaf", { pm: "S1" }));
  assert.equal(r.run, "leaf#2");
  assert.ok(r.queued);
  assert.equal(t.f.store.getRun("outer#1")!.entries.inner.child, "leaf#2");
  assert.equal(t.f.store.getRun("leaf#2")!.parent?.run, "outer#1");
  await t.f.close();
});

const finish = (run: string, entry: string) => ({ type: "entry.report", data: { run, entry, outcome: "done", by: "human" }, source: "ui" });

test("a nested run that ends done hands back the vars it set, and its parent goes on in the same agent", async () => {
  const { f, agterm, clock } = await outerOnInner({}, { vars: { issue: "K-1", title: "T" } });
  await f.submit(start("leaf", { pm: "S1" }));
  await settle(f);
  // the agent's turns are the nested run's: they reach the parent too, and change nothing there
  await f.submit(status("S1", "active"));
  await f.submit(status("S1", "completed"));
  clock.t += 120_000;
  await f.tickNow();
  await settle(f);
  assert.deepEqual([f.store.getRun("outer#1")!.entries.inner.status, f.store.getRun("outer#1")!.status], ["waiting", "running"]);
  assert.deepEqual(agterm.typed().filter((c) => c.includes("outer#1") || c.includes("is not closed")), ["type S1 ▶ flow: step b · outer#1 it.1 — run `flow show` for the instructions"]);
  await f.submit({ type: "run.set", run: "leaf#1", data: { vars: { pr: "u", title: "T" } }, source: "cli" });
  await f.submit(finish("leaf#1", "b"));
  await settle(f);
  const outer = f.store.getRun("outer#1")!;
  assert.deepEqual([outer.entries.inner.status, outer.entries.inner.note, outer.current], ["done", "leaf#1 done", "c"]);
  assert.deepEqual([outer.vars.pr, outer.vars.issue], ["u", "K-1"]);
  assert.equal(f.store.runBySession("S1")?.run.id, "outer#1");
  await f.submit(status("S1", "completed"));
  clock.t += 20_000;
  await settle(f);
  assert.ok(agterm.typed().some((c) => c.startsWith("type S1 ▶ flow: step c · outer#1")), agterm.typed().join("\n"));
  await f.close();
});

test("a stopped nested run fails its parent's inner; a stopped parent stops its nested run", async () => {
  const a = await outerOnInner();
  await a.f.submit(start("leaf", { pm: "S1" }));
  await a.f.submit({ type: "run.stop", run: "leaf#1", data: {}, source: "ui" });
  await settle(a.f);
  const outer = a.f.store.getRun("outer#1")!;
  assert.deepEqual([outer.status, outer.reason], ["needs-human", "inner failed: leaf#1 stopped"]);
  await a.f.close();
  const b = await outerOnInner({}, { inner: ["mid", "leaf"] });
  await b.f.submit({ type: "run.stop", run: "outer#1", data: {}, source: "ui" });
  await settle(b.f);
  assert.deepEqual(["outer#1", "mid#1", "leaf#1"].map((id) => b.f.store.getRun(id)!.status), ["stopped", "stopped", "stopped"]);
  await b.f.close();
});

test("three levels unwind in order on one agent", async () => {
  const { f } = await outerOnInner({}, { inner: ["mid", "leaf"] });
  await f.submit(finish("leaf#1", "b"));
  await settle(f);
  assert.deepEqual([f.store.getRun("mid#1")!.current, f.store.runBySession("S1")?.run.id], ["c", "mid#1"]);
  await f.submit(finish("mid#1", "c"));
  await settle(f);
  assert.deepEqual([f.store.getRun("outer#1")!.current, f.store.runBySession("S1")?.run.id], ["c", "outer#1"]);
  await f.close();
});

test("after a restart a parent learns its nested run ended", async () => {
  const t = await outerOnInner({}, { inner: ["leaf"] });
  await t.f.close();
  // the nested run ended while flowd was down, before the parent heard of it
  const store = new Store(join(t.home, "state.db"));
  const leaf = store.getRun("leaf#1")!;
  store.saveRun({ ...leaf, status: "done", current: null });
  store.close();
  const third = await startFlowd(t.home, { agterm: t.agterm });
  await settle(third.f);
  assert.deepEqual([third.f.store.getRun("outer#1")!.entries.inner.status, third.f.store.getRun("outer#1")!.current], ["done", "c"]);
  await third.f.close();
});

test("a bare inner waits for the person; the UI's nest starts a process there or says why not, leaving the inner alone", async () => {
  const pair = { "processes/pair.yaml": "description: d\ncwd: /tmp\nroles: {a: {spawn: claude}, b: {spawn: claude}}\nsteps:\n  - {step: b, role: a}\n" };
  const { f } = await outerOnInner(pair);
  assert.equal(f.runSummary(f.store.getRun("outer#1")!).needsYou, true);
  const nest = (process: string) => f.submit({ type: "run.nest", run: "outer#1", data: { process, ui: true }, source: "ui" });
  assert.equal((await nest("pair")).error, "pair has roles a, b; none is pm");
  assert.equal((await nest("nope")).error, "no valid process nope");
  assert.deepEqual([f.store.getRun("outer#1")!.status, f.store.getRun("outer#1")!.entries.inner.status], ["running", "waiting"]);
  assert.equal((await nest("leaf")).run, "leaf#1");
  assert.equal(f.runSummary(f.store.getRun("outer#1")!).needsYou, false);
  assert.equal((await nest("leaf")).error, "outer#1 is not waiting for a nested process");
  await f.close();
  const chained = await outerOnInner({}, { inner: ["leaf"] });
  assert.equal(chained.f.runSummary(chained.f.store.getRun("outer#1")!).needsYou, false);
  await chained.f.close();
});
