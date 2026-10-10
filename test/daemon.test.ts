import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAgterm, STEP_FILES, makeHome, proc, settle, startFlowd, watches, resetWatches, previouses, subs, pluginCtx, ctxOf, resetSubs } from "./daemon-helpers.ts";

const TWO = proc("  - {step: b, role: pm}\n  - {step: c, role: pm}\n");
const start = (process: string, bind?: Record<string, string>) => ({ type: "run.start", data: { process, bind }, source: "test" });
const status = (session: string, s: string) => ({ type: "agterm.status", data: { session, status: s }, source: "agterm" });
const report = (data: Record<string, unknown>) => ({ type: "entry.report", data, source: "cli" });

test("a start spawns the role with the nudge as its first prompt, binds it and marks it delivered", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }));
  assert.deepEqual(await f.submit(start("p")), { run: "p#1" });
  await settle(f);
  assert.equal(agterm.calls.length, 1);
  assert.ok(agterm.calls[0].startsWith("spawn S1 p | p#1 pm | /tmp | claude '▶ flow: step b · p#1 it.1"), agterm.calls[0]);
  const run = f.store.getRun("p#1")!;
  assert.equal(run.roles.pm, "S1");
  assert.ok(run.entries.b.deliveredAt);
  await f.close();
});

test("a report from the session advances; the next line waits for an idle session and the spawn grace", async () => {
  const { f, agterm, clock } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }));
  await f.submit(start("p"));
  await settle(f);
  await f.submit(status("S1", "active"));
  assert.deepEqual(await f.submit(report({ session: "S1", outcome: "done", note: "ok" })), { run: "p#1" });
  await settle(f);
  assert.deepEqual(agterm.typed(), []);
  await f.submit(status("S1", "completed"));
  await settle(f);
  assert.deepEqual(agterm.typed(), []);
  clock.t += 17_000; // 15 s spawn grace + 2 s gap
  await settle(f);
  assert.deepEqual(agterm.typed(), ["type S1 ▶ flow: step c · p#1 it.1 — run `flow show` for the instructions"]);
  assert.ok(f.store.getRun("p#1")!.entries.c.deliveredAt);
  await f.close();
});

test("a second flow done from the same session cannot close the next step before it arrives", async () => {
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }));
  await f.submit(start("p"));
  await settle(f);
  await f.submit(status("S1", "active"));
  await f.submit(report({ session: "S1", outcome: "done" }));
  const second = await f.submit(report({ session: "S1", outcome: "done" }));
  assert.equal(second.error, "step c has not reached the agent yet");
  assert.equal(f.store.getRun("p#1")!.entries.c.status, "active");
  await f.close();
});

test("reports that cannot be placed are refused with a reason", async () => {
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }));
  await f.submit(start("p"));
  await settle(f);
  assert.equal((await f.submit(report({ session: "S9", outcome: "done" }))).error, "no open run is bound to this session");
  assert.match((await f.submit(report({ outcome: "done" }))).error!, /no session/);
  assert.equal((await f.submit(report({ session: "S1", outcome: "maybe" }))).error, "outcome must be done or failed");
  await f.close();
});

test("broadcast events wake matching waits and start triggered processes; over max_runs they queue", async () => {
  resetWatches();
  const home = makeHome({
    ...STEP_FILES,
    ...proc("  - {id: w, wait_for: {on: test.ping, where: {k: \"1\"}}}\n  - {step: c, role: human}\n"),
    ...proc("  - {step: b, role: pm}\n", "triggers:\n  - {on: flow.run.done, where: {process: p}}\n", "q"),
  });
  const { f } = await startFlowd(home);
  await f.submit(start("p"));
  assert.deepEqual(watches(), ["p#1/w"]);
  await f.submit({ type: "test.ping", data: { k: "2" }, source: "test" });
  assert.equal(f.store.getRun("p#1")!.entries.w.status, "waiting");
  await f.submit({ type: "test.ping", data: { k: "1" }, source: "test" });
  assert.equal(f.store.getRun("p#1")!.current, "c");
  await f.submit(report({ run: "p#1", entry: "c", outcome: "done", by: "human" }));
  await settle(f);
  assert.equal(f.store.getRun("p#1")!.status, "done");
  assert.ok(f.store.getRun("q#1"), "q was started by p's flow.run.done");
  await f.submit({ type: "flow.run.done", data: { process: "p", run: "p#x" }, source: "test" });
  await settle(f);
  assert.equal(f.store.getRun("q#2")!.status, "queued");
  assert.equal(f.store.getRun("q#2")!.queuedEvent?.type, "flow.run.done");
  await f.close();
});

test("after a restart, waits are re-armed and queued lines are delivered; stale nudges are dropped", async () => {
  resetWatches();
  const home = makeHome({
    ...STEP_FILES,
    ...proc("  - {step: b, role: pm}\n  - {id: w, wait_for: test.ping}\n"),
    ...proc("  - {step: c, role: pm}\n", "", "q"),
  });
  const A = await startFlowd(home, { agterm: new FakeAgterm().addSession("S1", "S2") });
  await A.f.submit(status("S1", "active"));
  await A.f.submit(status("S2", "active"));
  await A.f.submit(start("p", { pm: "S1" }));
  await A.f.submit(report({ run: "p#1", entry: "b", outcome: "done", by: "human" }));
  await A.f.submit(start("q", { pm: "S2" }));
  await settle(A.f);
  assert.deepEqual(A.agterm.typed(), [], "b's nudge went stale, c's waits for S2");
  await A.f.close();

  resetWatches();
  const B = await startFlowd(home, { agterm: new FakeAgterm().addSession("S1", "S2") });
  await settle(B.f);
  assert.deepEqual(watches(), ["p#1/w"]);
  assert.deepEqual(B.agterm.typed(), ["type S2 ▶ flow: step c · q#1 it.1 — run `flow show` for the instructions"]);
  await B.f.close();
});

test("a bound session missing from agterm at startup is treated as closed", async () => {
  const home = makeHome({ ...STEP_FILES, ...TWO });
  const A = await startFlowd(home, { agterm: new FakeAgterm().addSession("S1") });
  await A.f.submit(start("p", { pm: "S1" }));
  await A.f.close();
  const B = await startFlowd(home, { agterm: new FakeAgterm() });
  await settle(B.f);
  const run = B.f.store.getRun("p#1")!;
  assert.equal(run.roles.pm, null);
  await B.f.close();
});

test("a definition edit that removes the current entry stops the run at the next tick", async () => {
  const home = makeHome({ ...STEP_FILES, ...TWO });
  const { f } = await startFlowd(home);
  await f.submit(start("p"));
  await settle(f);
  writeFileSync(join(home, "processes/p.yaml"), "description: d\ncwd: /tmp\nroles: {pm: {spawn: claude}}\nsteps:\n  - {step: c, role: pm}\n");
  f.reloadDefs();
  await f.tickNow();
  const run = f.store.getRun("p#1")!;
  assert.equal(run.status, "needs-human");
  assert.equal(run.reason, "entry b no longer exists");
  writeFileSync(join(home, "processes/p.yaml"), "description: [");
  f.reloadDefs();
  assert.match((await f.submit(start("p"))).error!, /no valid process p: yaml/);
  await f.close();
});

test("three failed spawns stop the run with the reason", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }));
  agterm.failSpawn = 3;
  await f.submit(start("p"));
  await settle(f);
  const run = f.store.getRun("p#1")!;
  assert.equal(run.status, "needs-human");
  assert.equal(run.reason, "spawn failed: no agterm");
  await f.close();
});

test("three failed typings treat the session as closed", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  agterm.failType = 3;
  await f.submit(start("p", { pm: "S1" }));
  await settle(f);
  const run = f.store.getRun("p#1")!;
  assert.equal(run.roles.pm, null);
  assert.equal(run.status, "needs-human");
  assert.equal(run.reason, "role pm session closed");
  await f.close();
});

test("compact finishes on Claude's PostCompact report from the bound session", async () => {
  const { f, agterm, clock } = await startFlowd(makeHome({ ...STEP_FILES, ...proc("  - {do: compact, role: pm}\n  - {step: c, role: pm}\n") }),
    { agterm: new FakeAgterm().addSession("S1") });
  await f.submit(start("p", { pm: "S1" }));
  await settle(f);
  assert.deepEqual(agterm.typed(), ["type S1 /compact"]);
  await f.submit({ type: "claude.compacted", data: { session: "S2" }, source: "claude" });
  assert.equal(f.store.getRun("p#1")!.entries.compact.status, "active");
  await f.submit({ type: "claude.compacted", data: { session: "S1" }, source: "claude" });
  clock.t += 2_000;
  await settle(f);
  assert.equal(agterm.typed()[1], "type S1 ▶ flow: step c · p#1 it.1 — run `flow show` for the instructions");
  await f.close();
});

test("plugin actions are run and reported", async () => {
  const ok = await startFlowd(makeHome({ ...STEP_FILES, ...proc("  - {do: test.post, with: {m: hi}}\n  - {step: c, role: human}\n") }));
  await ok.f.submit(start("p"));
  await settle(ok.f);
  assert.equal(ok.f.store.getRun("p#1")!.current, "c");
  await ok.f.close();
  const bad = await startFlowd(makeHome({ ...STEP_FILES, ...proc("  - {do: test.post, with: {fail: yes}}\n") }));
  await bad.f.submit(start("p"));
  await settle(bad.f);
  assert.equal(bad.f.store.getRun("p#1")!.reason, "test.post failed: post failed");
  await bad.f.close();
});

test("show renders the step for its session; preview renders against a run", async () => {
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }));
  await f.submit(start("p"));
  await settle(f);
  const shown = f.show({ session: "S1" });
  assert.ok("text" in shown && shown.text.includes("Do B for p#1") && shown.text.includes("step b (role pm)"), JSON.stringify(shown));
  assert.deepEqual(f.show({ session: "S9" }), { error: "no open run is bound to this session" });
  assert.deepEqual(f.preview("run {{run.id}}", "p#1"), { text: "run p#1" });
  assert.deepEqual(f.preview("{{vars.x}}"), { error: "{{vars.x}} has no value" });
  await f.close();
});

test("show renders a human step's instructions with how to close it", async () => {
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...proc("  - {step: c, role: human}\n") }));
  await f.submit(start("p"));
  await settle(f);
  const shown = f.show({ run: "p#1", entry: "c" });
  assert.ok("text" in shown && shown.text.includes("Do C") && shown.text.includes("flow done --human --run 'p#1' --step c"), JSON.stringify(shown));
  await f.close();
});

test("a paused run holds its lines until resumed", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  await f.submit(status("S1", "active"));
  await f.submit(start("p", { pm: "S1" }));
  await f.submit({ type: "run.pause", run: "p#1", data: {}, source: "ui" });
  await f.submit(status("S1", "completed"));
  await settle(f);
  assert.deepEqual(agterm.typed(), []);
  await f.submit({ type: "run.resume", run: "p#1", data: {}, source: "ui" });
  await settle(f);
  assert.equal(agterm.typed().length, 1);
  await f.close();
});

test("a session already bound to an open run cannot be bound again", async () => {
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO, ...proc("  - {step: c, role: pm}\n", "", "q") }),
    { agterm: new FakeAgterm().addSession("X1") });
  await f.submit(start("p", { pm: "X1" }));
  assert.equal((await f.submit(start("q", { pm: "X1" }))).error, "session X1 is already bound to p#1");
  await f.submit(start("q"));
  assert.equal((await f.submit({ type: "role.bind", run: "q#1", data: { role: "pm", session: "X1", by: "human" }, source: "ui" })).error,
    "session X1 is already bound to p#1");
  await f.close();
});

// --- repo-review round 1 ---

test("a run that needs the human spawns nothing for its queued lines; a respawn spawns one agent", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  await f.submit(status("S1", "active"));
  await f.submit(start("p", { pm: "S1" })); // b's nudge waits: S1 is mid-turn
  await f.submit({ type: "agterm.closed", data: { session: "S1" }, source: "agterm" });
  await settle(f);
  assert.equal(f.store.getRun("p#1")!.status, "needs-human");
  assert.deepEqual(agterm.calls.filter((c) => c.startsWith("spawn")), []);
  await f.submit({ type: "role.respawn", run: "p#1", data: { role: "pm" }, source: "ui" });
  await settle(f);
  assert.equal(agterm.calls.filter((c) => c.startsWith("spawn")).length, 1, agterm.calls.join("\n"));
  await f.close();
});

test("a run that ends on a typed line still types it", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...proc("  - {step: c, role: human}\n  - {do: type, role: pm, text: bye}\n") }),
    { agterm: new FakeAgterm().addSession("S1") });
  await f.submit(start("p", { pm: "S1" }));
  await f.submit(report({ run: "p#1", entry: "c", outcome: "done", by: "human" }));
  await settle(f);
  assert.equal(f.store.getRun("p#1")!.status, "done");
  assert.deepEqual(agterm.typed(), ["type S1 bye"]);
  await f.close();
});

const SLOW_PLUGIN = `export default { name: "slow", actions: { wait() { return new Promise(() => {}); } } };\n`;

test("a plugin action still running when flowd restarts fails instead of hanging", async () => {
  const home = makeHome({ ...STEP_FILES, "plugins/slow.ts": SLOW_PLUGIN, ...proc("  - {do: slow.wait}\n  - {step: c, role: human}\n") });
  const A = await startFlowd(home);
  await A.f.submit(start("p"));
  await settle(A.f);
  assert.equal(A.f.store.getRun("p#1")!.entries["slow.wait"].status, "active");
  await A.f.close();
  const B = await startFlowd(home);
  await settle(B.f);
  const run = B.f.store.getRun("p#1")!;
  assert.equal(run.entries["slow.wait"].status, "failed");
  assert.match(run.reason ?? "", /flowd restarted while the action ran/);
  await B.f.close();
});

test("a live edit of a waiting entry's wait_for moves its watch", async () => {
  resetWatches();
  const home = makeHome({ ...STEP_FILES, ...proc("  - {id: w, wait_for: signal.go}\n  - {step: c, role: human}\n") });
  const { f } = await startFlowd(home);
  await f.submit(start("p"));
  assert.deepEqual(watches(), []);
  writeFileSync(join(home, "processes/p.yaml"), "description: d\ncwd: /tmp\nroles: {pm: {spawn: claude}}\nsteps:\n  - {id: w, wait_for: test.ping}\n  - {step: c, role: human}\n");
  f.reloadDefs();
  assert.deepEqual(watches(), ["p#1/w"]);
  await f.submit({ type: "test.ping", data: {}, source: "test" });
  assert.equal(f.store.getRun("p#1")!.current, "c");
  await f.close();
});

test("a refused start of a process triggered by flow.trigger.skipped does not feed itself", async () => {
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...proc("  - {step: c, role: human}\n", "triggers: [{on: flow.trigger.skipped}]\n", "n") }));
  await f.submit(start("n"));
  await f.submit({ type: "flow.trigger.skipped", data: { process: "x", trigger: "cron" }, source: "test" });
  await settle(f);
  const n = Number((f.store.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'flow.trigger.skipped'").get() as { n: number }).n);
  assert.equal(n, 1, `${n} flow.trigger.skipped events`);
  await f.close();
});

test("a turn that ended while flowd was down still gets its reminder", async () => {
  const home = makeHome({ ...STEP_FILES, ...TWO });
  const A = await startFlowd(home, { agterm: new FakeAgterm().addSession("S1") });
  await A.f.submit(start("p", { pm: "S1" }));
  await settle(A.f);
  await A.f.submit(status("S1", "active"));
  await A.f.close();
  const agterm = new FakeAgterm();
  agterm.sessions.push({ id: "S1", name: "S1", cwd: "/", workspace: "W", status: "idle" });
  const B = await startFlowd(home, { agterm });
  await settle(B.f);
  B.clock.t += 30_000;
  await B.f.tickNow();
  await settle(B.f);
  assert.ok(B.agterm.typed().some((t) => t.includes("step b is not closed")), B.agterm.typed().join("\n"));
  await B.f.close();
});

test("a session blocked on a permission prompt gets no line until its turn ends", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  await f.submit(status("S1", "active"));
  await f.submit(start("p", { pm: "S1" }));
  await f.submit(status("S1", "blocked"));
  await settle(f);
  assert.deepEqual(agterm.typed(), []);
  await f.submit(status("S1", "completed"));
  await settle(f);
  assert.equal(agterm.typed().length, 1);
  await f.close();
});

test("a wait whose with no longer renders after a restart stops the run", async () => {
  const yaml = (k: string) => `description: d\ncwd: /tmp\nroles: {pm: {spawn: claude}}\nsteps:\n  - {step: c, role: human}\n  - {id: w, wait_for: {on: test.ping, with: {k: "{{vars.${k}}}"}}}\n`;
  const home = makeHome({ ...STEP_FILES, "processes/p.yaml": yaml("k") });
  const A = await startFlowd(home);
  await A.f.submit(start("p"));
  await A.f.submit({ type: "run.set", run: "p#1", data: { vars: { k: "1" } }, source: "test" });
  await A.f.submit(report({ run: "p#1", entry: "c", outcome: "done", by: "human" }));
  assert.equal(A.f.store.getRun("p#1")!.entries.w.status, "waiting");
  await A.f.close();
  writeFileSync(join(home, "processes/p.yaml"), yaml("nope"));
  const B = await startFlowd(home);
  await settle(B.f);
  const run = B.f.store.getRun("p#1")!;
  assert.equal(run.status, "needs-human");
  assert.match(run.reason ?? "", /vars\.nope/);
  await B.f.close();
});

test("an on: trigger hands its event to the run's first entry", async () => {
  const { f } = await startFlowd(makeHome({
    ...STEP_FILES, "steps/greet.md": "---\nsummary: g\n---\nGot {{event.data.msg}} from {{event.type}}\n",
    ...proc("  - {step: greet, role: pm}\n", "triggers: [{on: signal.go}]\n"),
  }));
  await f.submit({ type: "signal.go", data: { msg: "hi" }, source: "cli" });
  await settle(f);
  const shown = f.show({ run: "p#1", entry: "greet" });
  assert.ok("text" in shown && shown.text.includes("Got hi from signal.go"), JSON.stringify(shown));
  await f.close();
});

// --- repo-review round 2 ---

test("a reload that leaves a wait_for unchanged keeps its watch", async () => {
  resetWatches();
  const home = makeHome({ ...STEP_FILES, ...proc("  - {id: w, wait_for: test.ping}\n  - {step: c, role: human}\n") });
  const { f } = await startFlowd(home);
  await f.submit(start("p"));
  assert.deepEqual(watches(), ["p#1/w"]);
  f.reloadDefs();
  assert.deepEqual(watches(), ["p#1/w"], "re-armed although nothing changed");
  await f.close();
});

test("a report stored before a crash wins over the restart's failure of the cut-off action", async () => {
  const home = makeHome({ ...STEP_FILES, "plugins/slow.ts": SLOW_PLUGIN, ...proc("  - {do: slow.wait}\n  - {step: c, role: human}\n") });
  const A = await startFlowd(home);
  await A.f.submit(start("p"));
  await settle(A.f);
  A.f.store.addEvent({ type: "entry.report", data: { run: "p#1", entry: "slow.wait", outcome: "done", by: "system" }, source: "flowd" });
  await A.f.close(); // the report is stored, never processed: as after a crash
  const B = await startFlowd(home);
  await settle(B.f);
  const run = B.f.store.getRun("p#1")!;
  assert.equal(run.entries["slow.wait"].status, "done");
  assert.equal(run.entries["slow.wait"].failures, 0, "a synthetic failure was processed first");
  assert.equal(run.current, "c");
  await B.f.close();
});

const QUICK_PLUGIN = `const g = globalThis as any;
export default { name: "quick", events: ["now"], watch(w: any, ctx: any) { if (g.__quickFire) ctx.emit({ type: "now", run: w.run, entry: w.entry }); return () => {}; } };
`;

test("an action started by a wait that fires right after a restart is not failed as cut off", async () => {
  (globalThis as any).__quickFire = false;
  const home = makeHome({ ...STEP_FILES, "plugins/slow.ts": SLOW_PLUGIN, "plugins/quick.ts": QUICK_PLUGIN,
    ...proc("  - {id: w, wait_for: quick.now}\n  - {do: slow.wait}\n  - {step: c, role: human}\n") });
  const A = await startFlowd(home);
  await A.f.submit(start("p"));
  assert.equal(A.f.store.getRun("p#1")!.entries.w.status, "waiting");
  await A.f.close();
  (globalThis as any).__quickFire = true;
  const B = await startFlowd(home);
  await settle(B.f);
  (globalThis as any).__quickFire = false;
  const run = B.f.store.getRun("p#1")!;
  assert.equal(run.entries["slow.wait"].status, "active", run.reason ?? "");
  assert.equal(run.status, "running");
  await B.f.close();
});

// --- plugin events as triggers ---

const TRIGGERED = (name: string, extra = "") =>
  proc("  - {step: c, role: human}\n", `triggers:\n  - {on: test.ping, with: {k: 1}${extra}}\n`, name);

test("processes with the same trigger share one subscription; its broadcast starts each of them", async () => {
  resetSubs();
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TRIGGERED("a"), ...TRIGGERED("b") }));
  assert.equal(subs().length, 1);
  assert.deepEqual([...subs()[0].processes].sort(), ["a", "b"]);
  assert.equal(subs()[0].cwd, "/tmp");
  pluginCtx().emit({ type: "ping", data: { pr: "u1", n: 3 } });
  await settle(f);
  assert.deepEqual(f.store.getRun("a#1")!.vars, { pr: "u1", n: "3", trigger: "test.ping" });
  assert.ok(f.store.getRun("b#1"));
  await f.close();
});

test("a reload keeps unchanged subscriptions and replaces changed ones", async () => {
  resetSubs();
  const home = makeHome({ ...STEP_FILES, ...TRIGGERED("a"), ...TRIGGERED("b") });
  const { f } = await startFlowd(home);
  const first = subs()[0];
  writeFileSync(join(home, "processes/b.yaml"), "description: changed\ncwd: /tmp\ntriggers:\n  - {on: test.ping, with: {k: 1}}\nsteps:\n  - {step: c, role: human}\n");
  f.reloadDefs();
  assert.equal(subs()[0], first, "same subscription object: not recreated");
  writeFileSync(join(home, "processes/b.yaml"), "description: d\ncwd: /tmp\ntriggers:\n  - {on: test.ping, with: {k: 2}}\nsteps:\n  - {step: c, role: human}\n");
  f.reloadDefs();
  assert.equal(subs().length, 2);
  assert.deepEqual(subs()[0].processes, ["a"]);
  writeFileSync(join(home, "processes/a.yaml"), "description: d\ncwd: /tmp\nsteps:\n  - {step: c, role: human}\n");
  f.reloadDefs();
  assert.deepEqual(subs().map((s) => s.with.k), [2]);
  await f.close();
  assert.deepEqual(subs(), []);
});

// --- plugin triggers: final review ---

test("a subscription's event starts only the processes whose trigger it serves", async () => {
  resetSubs();
  const { f } = await startFlowd(makeHome({
    ...STEP_FILES,
    ...proc("  - {step: c, role: human}\n", "triggers:\n  - {on: test.ping, with: {k: 1}}\n", "a"),
    ...proc("  - {step: c, role: human}\n", "triggers:\n  - {on: test.ping, with: {k: 2}}\n", "b"),
  }));
  const k1 = subs().find((s) => s.with.k === 1);
  ctxOf(k1).emit({ type: "ping", data: { n: 1 } });
  await settle(f);
  assert.ok(f.store.getRun("a#1"), "a's subscription fired");
  assert.equal(f.store.getRun("b#1"), null, "b asked for k: 2, not k: 1");
  await f.close();
});

test("a subscription's event wakes no wait: waits have their own watch", async () => {
  resetSubs();
  const { f } = await startFlowd(makeHome({
    ...STEP_FILES,
    ...proc("  - {id: w, wait_for: test.ping}\n  - {step: c, role: human}\n", "", "waiter"),
    ...proc("  - {step: c, role: human}\n", "triggers:\n  - {on: test.ping}\n", "trig"),
  }));
  await f.submit(start("waiter"));
  ctxOf(subs()[0]).emit({ type: "ping", data: {} });
  await settle(f);
  assert.ok(f.store.getRun("trig#1"));
  assert.equal(f.store.getRun("waiter#1")!.entries.w.status, "waiting");
  await f.close();
});

const EAGER_PLUGIN = `export default { name: "eager", events: ["go"], watch(w: any, ctx: any) { if (!w.run) ctx.emit({ type: "go", data: {} }); return () => {}; } };\n`;

test("a subscription that fires at startup does not get its run's first action failed as cut off", async () => {
  const { f } = await startFlowd(makeHome({
    ...STEP_FILES, "plugins/slow.ts": SLOW_PLUGIN, "plugins/eager.ts": EAGER_PLUGIN,
    ...proc("  - {do: slow.wait}\n  - {step: c, role: human}\n", "triggers:\n  - {on: eager.go}\n", "e"),
  }));
  await settle(f);
  const run = f.store.getRun("e#1")!;
  assert.equal(run.entries["slow.wait"].status, "active");
  assert.equal(run.entries["slow.wait"].failures, 0, run.reason ?? "");
  await f.close();
});
test("flow wait from the agent's own session parks on its turn end; nothing but the nudge is typed", async () => {
  const { f, clock, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  await f.submit(start("p", { pm: "S1" }));
  await settle(f);
  await f.submit(status("S1", "active"));
  assert.deepEqual(await f.submit({ type: "entry.wait", data: { session: "S1", note: "review running" }, source: "cli" }), { run: "p#1" });
  assert.equal(f.store.getRun("p#1")!.entries.b.wait?.parked, false);
  await f.submit(status("S1", "completed"));
  clock.t += 120_000;
  await f.tickNow();
  await settle(f);
  assert.equal(agterm.typed().length, 1);
  const summary = f.runSummary(f.store.getRun("p#1")!);
  assert.equal(summary.agentWait?.note, "review running");
  assert.equal(summary.needsYou, false);
  await f.close();
});

test("a run summary carries its times and what the UI says about each entry", async () => {
  const steps = "  - {step: b, role: pm, on_fail: {goto: fix}}\n  - {id: wipe, do: clear, role: pm}\n"
    + "  - {step: c, role: human}\n  - {id: fix, step: c, role: pm, detour: true, after: {goto: b}}\n";
  const { f, clock } = await startFlowd(makeHome({ ...STEP_FILES, ...proc(steps) }), { agterm: new FakeAgterm().addSession("S1") });
  await f.submit(start("p", { pm: "S1" }));
  await settle(f);
  clock.t += 5_000;
  await f.submit(report({ run: "p#1", entry: "b", outcome: "done", note: "did b", by: "human" }));
  await settle(f);
  const s = f.runSummary(f.store.getRun("p#1")!);
  assert.equal(s.created, 1_000_000);
  assert.ok(s.updated >= 1_005_000);
  const [b, wipe, c, fix] = s.plan;
  assert.deepEqual([b.step, b.summary, b.note, b.onFail, b.after, b.do], ["b", "b", "did b", { goto: "fix" }, null, null]);
  assert.equal(typeof b.startedAt, "number");
  assert.deepEqual([wipe.kind, wipe.do, wipe.summary, wipe.step], ["action", "clear", null, null]);
  assert.deepEqual([c.kind, c.summary], ["human", "c"]);
  assert.deepEqual([fix.detour, fix.after, fix.startedAt], [true, { goto: "b" }, null]);
  await f.close();
});

test("a wait sent with --run/--step from another session after the agent's turn ended starts parked; --human puts the run under needs-you", async () => {
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1", "ME") });
  await f.submit(start("p", { pm: "S1" }));
  await settle(f);
  await f.submit(status("S1", "active"));
  await f.submit(status("S1", "completed")); // no turn end will follow to park it
  await f.submit({ type: "entry.wait", data: { session: "ME", run: "p#1", entry: "b", note: "user reads the PR", human: true }, source: "cli" });
  const run = f.store.getRun("p#1")!;
  assert.equal(run.entries.b.wait?.parked, true);
  assert.equal(f.runSummary(run).needsYou, true);
  await f.close();
});

test("a wait declared while the agent's session is blocked or mid-turn parks on that turn's end, whoever sent it", async () => {
  // blocked: the flow wait call itself hit a permission prompt; the late active is the same turn
  const A = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  await A.f.submit(start("p", { pm: "S1" }));
  await settle(A.f);
  await A.f.submit(status("S1", "active"));
  await A.f.submit(status("S1", "blocked"));
  await A.f.submit({ type: "entry.wait", data: { session: "S1", note: "review running" }, source: "cli" });
  assert.equal(A.f.store.getRun("p#1")!.entries.b.wait?.parked, false);
  await A.f.submit(status("S1", "active"));
  await A.f.submit(status("S1", "completed"));
  A.clock.t += 40_000;
  await A.f.tickNow();
  await settle(A.f);
  assert.equal(A.agterm.typed().length, 1, A.agterm.typed().join("\n"));
  await A.f.close();
  // the user's own terminal while the agent is mid-turn: a repeated active must not use the wait up
  const B = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1", "ME") });
  await B.f.submit(start("p", { pm: "S1" }));
  await settle(B.f);
  await B.f.submit(status("S1", "active"));
  await B.f.submit({ type: "entry.wait", data: { session: "ME", run: "p#1", entry: "b", note: "user reads the PR", human: true }, source: "cli" });
  await B.f.submit(status("S1", "active"));
  await B.f.submit(status("S1", "completed"));
  const run = B.f.store.getRun("p#1")!;
  assert.equal(run.entries.b.wait?.parked, true);
  assert.equal(B.f.runSummary(run).needsYou, true);
  await B.f.close();
});

const TRUST_REASON = 'b: Claude Code asks whether to trust /tmp and flowd could not select "Yes" — open the session and choose "Yes, I trust this folder"';
const claudeConfig = (home: string, trusted: string[]) => {
  const path = join(home, "claude.json");
  writeFileSync(path, JSON.stringify({ projects: Object.fromEntries(trusted.map((p) => [p, { hasTrustDialogAccepted: true }])) }));
  return path;
};

const DIALOG = (yesSelected: boolean) => ["Accessing workspace:", " /tmp", "Is this a project you trust?",
  yesSelected ? "   No, exit" : " ❯ No, exit", yesSelected ? " ❯ Yes, I trust this folder" : "   Yes, I trust this folder",
  "Enter to confirm · Esc to cancel"].join("\n");
const pressed = (a: FakeAgterm) => a.calls.filter((c) => c.startsWith("press "));

test("flowd answers Claude's folder-trust dialog: Down, then Enter once Yes is selected", async () => {
  const home = makeHome({ ...STEP_FILES, ...TWO });
  const agterm = new FakeAgterm();
  agterm.screens.set("S1", DIALOG(false));
  agterm.onPress = (s, k) => {
    if (k === "\x1b[B") agterm.screens.set(s, DIALOG(true));
    if (k === "\r") agterm.screens.set(s, "claude is up");
  };
  const { f } = await startFlowd(home, { agterm, claudeConfig: claudeConfig(home, ["/elsewhere"]), trustPollMs: 1 });
  await f.submit(start("p"));
  await settle(f);
  assert.deepEqual(pressed(agterm), ['press S1 "\\u001b[B"', 'press S1 "\\r"']);
  assert.equal(f.store.getRun("p#1")!.status, "running");
  await f.close();
});

test("when Yes cannot be selected, the run stops with the reason and resumes on the agent's first active", async () => {
  const home = makeHome({ ...STEP_FILES, ...TWO });
  const agterm = new FakeAgterm();
  agterm.screens.set("S1", DIALOG(false)); // Down changes nothing
  const { f } = await startFlowd(home, { agterm, claudeConfig: claudeConfig(home, ["/elsewhere"]), trustPollMs: 1 });
  await f.submit(start("p"));
  await settle(f);
  assert.deepEqual(pressed(agterm), ['press S1 "\\u001b[B"']);
  let run = f.store.getRun("p#1")!;
  assert.deepEqual([run.status, run.reason, run.startBlocked], ["needs-human", TRUST_REASON, "b"]);
  await f.submit(status("S1", "active"));
  run = f.store.getRun("p#1")!;
  assert.deepEqual([run.status, run.startBlocked], ["running", undefined]);
  await f.close();
});

test("no dialog within the window: nothing is pressed and the run goes on", async () => {
  const home = makeHome({ ...STEP_FILES, ...TWO });
  const agterm = new FakeAgterm();
  const { f } = await startFlowd(home, { agterm, claudeConfig: claudeConfig(home, ["/elsewhere"]), trustPollMs: 1 });
  await f.submit(start("p"));
  await settle(f);
  assert.deepEqual(pressed(agterm), []);
  assert.equal(f.store.getRun("p#1")!.status, "running");
  await f.close();
});

test("a trusted folder, a non-claude spawn, or no Claude config is not stopped", async () => {
  const trusted = makeHome({ ...STEP_FILES, ...TWO });
  const a = await startFlowd(trusted, { claudeConfig: claudeConfig(trusted, ["/tmp"]) });
  await a.f.submit(start("p"));
  await settle(a.f);
  assert.equal(a.f.store.getRun("p#1")!.status, "running");
  await a.f.close();
  const codex = makeHome({ ...STEP_FILES, "processes/p.yaml": "description: d\ncwd: /tmp\nroles: {pm: {spawn: codex}}\nsteps:\n  - {step: b, role: pm}\n" });
  const b = await startFlowd(codex, { claudeConfig: claudeConfig(codex, []) });
  await b.f.submit(start("p"));
  await settle(b.f);
  assert.equal(b.f.store.getRun("p#1")!.status, "running");
  await b.f.close();
  const none = makeHome({ ...STEP_FILES, ...TWO });
  const c = await startFlowd(none);
  await c.f.submit(start("p"));
  await settle(c.f);
  assert.equal(c.f.store.getRun("p#1")!.status, "running");
  await c.f.close();
});

test("a line waits while the caret is past the prompt or an overlay is open; a suggestion does not hold it", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  agterm.columns.set("surface:S1:left", 17); // the user is typing
  await f.submit(start("p", { pm: "S1" }));
  await settle(f);
  assert.deepEqual(agterm.typed(), []);
  agterm.columns.set("surface:S1:left", 2); // empty input box, whatever suggestion is drawn
  agterm.sessions[0].overlay = true;
  await settle(f);
  assert.deepEqual(agterm.typed(), []);
  agterm.sessions[0].overlay = false;
  await settle(f);
  assert.equal(agterm.typed().length, 1);
  await f.close();
});

test("an unreadable caret does not hold the line", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  agterm.columns.set("surface:S1:left", -1);
  await f.submit(start("p", { pm: "S1" }));
  await settle(f);
  assert.equal(agterm.typed().length, 1);
  await f.close();
});

test("a wait re-armed by retry is handed the event that woke it; after a restart too", async () => {
  resetWatches();
  const home = makeHome({ ...STEP_FILES, ...proc("  - {step: b, role: pm, wait_for: test.ping, on_fail: retry}\n  - {step: c, role: human}\n") });
  const A = await startFlowd(home, { agterm: new FakeAgterm().addSession("S1") });
  await A.f.submit(start("p", { pm: "S1" }));
  await A.f.submit({ type: "test.ping", data: { id: "R1" }, source: "test" });
  await settle(A.f);
  await A.f.submit(status("S1", "active"));
  await A.f.submit(report({ session: "S1", outcome: "failed", note: "waiting for re-review" }));
  assert.deepEqual(previouses(), [null, { type: "test.ping", data: { id: "R1" } }]);
  await A.f.close();
  resetWatches();
  const B = await startFlowd(home, { agterm: new FakeAgterm().addSession("S1") });
  await settle(B.f);
  assert.deepEqual(previouses(), [{ type: "test.ping", data: { id: "R1" } }]);
  await B.f.close();
});

test("a run on a pause says until when, and the plan says how long", async () => {
  const { f, clock } = await startFlowd(makeHome({ ...STEP_FILES, ...proc("  - {step: c, role: human}\n  - {id: tail, wait: 2h}\n") }));
  await f.submit(start("p"));
  await f.submit(report({ run: "p#1", entry: "c", outcome: "done", by: "human" }));
  const sum = f.runSummary(f.store.getRun("p#1")!);
  assert.equal(sum.waitUntil, clock.t + 7_200_000);
  assert.equal(sum.plan.find((e) => e.id === "tail")!.waitMs, 7_200_000);
  clock.t += 7_200_000;
  await f.tickNow();
  assert.equal(f.store.getRun("p#1")!.status, "done");
  await f.close();
});

const SH = (steps: string) => proc(steps, "", "p");
const shellOpts = { shell: ["/bin/sh", "-c"] };

test("a shell entry that exits 0 is done with its last line; a failing one fails with the exit code and stderr", async () => {
  const home = makeHome({ ...STEP_FILES, ...SH("  - {id: ok, sh: 'echo first; echo \"pr=$FLOW_VAR_PR run=$FLOW_RUN\"'}\n  - {id: bad, sh: 'echo oops >&2; exit 3'}\n") });
  const { f } = await startFlowd(home, shellOpts);
  await f.submit(start("p"));
  await f.submit({ type: "run.set", run: "p#1", data: { vars: { pr: "u1" } }, source: "test" });
  await settle(f);
  const run = f.store.getRun("p#1")!;
  assert.equal(run.entries.ok.status, "done");
  assert.equal(run.entries.ok.note, "pr= run=p#1"); // vars set after the command started are not seen
  assert.equal(run.entries.bad.status, "failed");
  assert.equal(run.entries.bad.note, "exit 3: oops");
  assert.equal(run.status, "needs-human");
  await f.close();
});

test("a shell entry sees the run's vars and runs in its cwd", async () => {
  const home = makeHome({ ...STEP_FILES, ...SH("  - {id: show, sh: 'echo \"$FLOW_VAR_PR $FLOW_EVENT_N $(pwd -P)\"', cwd: '{{vars.dir}}', wait_for: signal.go}\n") });
  const { f } = await startFlowd(home, shellOpts);
  await f.submit(start("p"));
  await f.submit({ type: "run.set", run: "p#1", data: { vars: { pr: "u1", dir: home } }, source: "test" });
  await f.submit({ type: "signal.go", data: { n: 7 }, source: "test" });
  await settle(f);
  assert.equal(f.store.getRun("p#1")!.entries.show.note, `u1 7 ${realpathSync(home)}`);
  await f.close();
});

test("a shell entry that runs too long is killed with everything it started and fails as timed out", async () => {
  // a compound command keeps sh as a parent: killing sh alone leaves sleep running (and, with dash,
  // holding the output open until it ends)
  const home = makeHome({ ...STEP_FILES, ...SH("  - {id: slow, sh: 'true; sh -c \"sleep 2; touch $FLOW_VAR_MARK\"', timeout: 1s}\n") });
  const mark = join(home, "survived");
  const { f } = await startFlowd(home, shellOpts);
  const t0 = Date.now();
  await f.submit({ type: "run.start", data: { process: "p", vars: { mark } }, source: "test" });
  await settle(f);
  const e = f.store.getRun("p#1")!.entries.slow;
  assert.deepEqual([e.status, e.note], ["failed", "timed out after 1s"]);
  assert.ok(Date.now() - t0 < 2_000, `took ${Date.now() - t0}ms`);
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(existsSync(mark), false, "the command's children outlived the timeout");
  await f.close();
});

test("a shell entry cut off by a restart fails so on_fail decides", async () => {
  const home = makeHome({ ...STEP_FILES, ...SH("  - {id: slow, sh: 'true; sh -c \"sleep 2; touch $FLOW_VAR_MARK\"'}\n") });
  const mark = join(home, "survived");
  const A = await startFlowd(home, shellOpts);
  await A.f.submit({ type: "run.start", data: { process: "p", vars: { mark } }, source: "test" });
  await new Promise((r) => setTimeout(r, 300)); // the command is running
  await A.f.close();
  await new Promise((r) => setTimeout(r, 2_500));
  assert.equal(existsSync(mark), false, "the command's children outlived the restart");
  const B = await startFlowd(home, shellOpts);
  await settle(B.f);
  const e = B.f.store.getRun("p#1")!.entries.slow;
  assert.deepEqual([e.status, e.note], ["failed", "flowd restarted while the command ran"]);
  await B.f.close();
});

test("a hold queues a second run until the first moves on; the first to queue is served first", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...proc("  - {step: b, role: pm, hold: desk}\n  - {step: c, role: pm}\n") }));
  f.defs.processes.p.maxRuns = 3;
  await f.submit(start("p", { pm: "S1" }));
  await f.submit(start("p", { pm: "S2" }));
  await f.submit(start("p", { pm: "S3" }));
  agterm.addSession("S1", "S2", "S3");
  await settle(f);
  assert.equal(f.store.getRun("p#1")!.entries.b.status, "active");
  assert.deepEqual(f.store.getRun("p#2")!.entries.b.queued?.hold, "desk");
  assert.deepEqual(f.runSummary(f.store.getRun("p#2")!).heldBy, { hold: "desk", run: "p#1" });
  await f.submit(report({ run: "p#1", entry: "b", outcome: "done", by: "human" }));
  await settle(f);
  assert.equal(f.store.getRun("p#2")!.entries.b.status, "active");
  assert.equal(f.store.getRun("p#3")!.entries.b.status, "waiting");
  await f.submit({ type: "run.stop", run: "p#2", data: {}, source: "test" });
  await settle(f);
  assert.equal(f.store.getRun("p#3")!.entries.b.status, "active");
  await f.close();
});

const TITLE_PLUGIN = `const g = globalThis as any;
export default { name: "titler", title({ vars }: any) { if (g.__titleFail) throw new Error("offline"); return vars.pr ? (g.__titles ?? {})[vars.pr] : undefined; } };\n`;

test("the run's title follows its PR: fetched when pr is set, refreshed on the timer, a failure keeps the old one", async () => {
  const g = globalThis as any;
  g.__titles = { "https://x/pull/1": "Fix the login timeout" };
  g.__titleFail = false;
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, "plugins/titler.ts": TITLE_PLUGIN, ...TWO }));
  await f.submit(start("p"));
  await settle(f);
  assert.equal(f.store.getRun("p#1")!.vars.title, undefined);
  await f.submit({ type: "run.set", run: "p#1", data: { vars: { pr: "https://x/pull/1" } }, source: "test" });
  await settle(f);
  assert.equal(f.store.getRun("p#1")!.vars.title, "Fix the login timeout");
  g.__titles["https://x/pull/1"] = "Fix the login timeout on slow networks";
  g.__titleFail = true;
  await f.refreshTitles();
  await settle(f);
  assert.equal(f.store.getRun("p#1")!.vars.title, "Fix the login timeout");
  g.__titleFail = false;
  await f.refreshTitles();
  await settle(f);
  assert.equal(f.store.getRun("p#1")!.vars.title, "Fix the login timeout on slow networks");
  await f.close();
});

test("a role spawns into the process's workspace under its name template", async () => {
  const { f, agterm, clock } = await startFlowd(makeHome({ ...STEP_FILES,
    "processes/p.yaml": "description: d\ncwd: /tmp\nworkspace: Log sync\nroles: {pm: {spawn: claude, name: \"sync {{run.date}} {{role}}\"}}\nsteps:\n  - {step: b, role: pm}\n" }));
  clock.t = new Date(2026, 9, 8, 7, 0).getTime();
  await f.submit(start("p"));
  await settle(f);
  assert.ok(agterm.calls[0].startsWith("spawn S1 Log sync | sync 2026-10-08 pm | /tmp |"), agterm.calls[0]);
  await f.close();
});

test("a spawn whose answer was lost adopts the session it opened instead of spawning another", async () => {
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }));
  agterm.lostSpawn = 1;
  await f.submit(start("p"));
  await settle(f);
  await f.flush();
  await settle(f);
  assert.equal(agterm.calls.filter((c) => c.startsWith("spawn ")).length, 1);
  const run = f.store.getRun("p#1")!;
  assert.equal(run.roles.pm, "S1");
  assert.ok(run.entries.b.deliveredAt);
  await f.close();
});

test("a start over max_runs queues; it starts when a run ends, and the rest hear their new place", async () => {
  const { f, agterm, clock } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }));
  agterm.addSession("S2", "S3");
  assert.deepEqual(await f.submit(start("p")), { run: "p#1" });
  const second = await f.submit({ type: "run.start", data: { process: "p", bind: { pm: "S2" }, vars: { title: "Second" } }, source: "test" });
  assert.deepEqual(second, { run: "p#2", queued: { position: 1, open: 1, max: 1 } });
  await f.submit(start("p", { pm: "S3" }));
  await settle(f);
  const q2 = f.store.getRun("p#2")!;
  assert.deepEqual([q2.status, q2.current, q2.vars.title, q2.roles.pm], ["queued", null, "Second", "S2"]);
  assert.deepEqual(f.runSummary(f.store.getRun("p#3")!).queue, { position: 2, open: 1, max: 1 });
  await f.submit({ type: "run.stop", run: "p#1", data: {}, source: "test" });
  await settle(f);
  assert.equal(f.store.getRun("p#2")!.status, "running");
  assert.equal(f.store.getRun("p#2")!.current, "b");
  clock.t += 20_000;
  await settle(f);
  assert.ok(agterm.typed().some((c) => c.startsWith("type S2 ▶ flow: step b · p#2")), agterm.typed().join("\n"));
  assert.ok(agterm.typed().includes("type S3 ▶ flow: p#3 is queued — now 1st in line (1 of 1 runs open). Nothing to do: it starts by itself."), agterm.typed().join("\n"));
  // a schedule does not queue
  await f.submit({ type: "run.start", data: { process: "p", trigger: "cron" }, source: "cron" });
  assert.equal(f.store.getRun("p#4"), null);
  await f.close();
});

// --- zmx as a second terminal ---

const ZMX = proc("  - {step: b, role: pm}\n  - {step: c, role: pm}\n", "terminal: zmx\n", "z");
const zmxFake = () => Object.assign(new FakeAgterm(), { prefix: "zmx:Z" });

test("a terminal: zmx process spawns through zmx, named flows-<run>-<role>-<spawn> and labelled; an agterm process through agterm", async () => {
  const zmx = zmxFake();
  const { f, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO, ...ZMX }), { zmx });
  await f.submit(start("z"));
  await settle(f);
  assert.ok(zmx.calls[0]?.startsWith("spawn zmx:Z1 zmx | flows-z-1-pm-1 | /tmp | claude '▶ flow: step b · z#1 it.1"), zmx.calls[0]);
  assert.ok(zmx.calls[0].endsWith(" | run=z.1 role=pm"), zmx.calls[0]);
  assert.equal(f.store.getRun("z#1")!.roles.pm, "zmx:Z1");
  await f.submit(start("p"));
  await settle(f);
  assert.deepEqual(agterm.calls.map((c) => c.split(" | ")[0]), ["spawn S1 p"]);
  assert.equal(zmx.calls.length, 1);
  await f.close();
});

test("a zmx session's lines and draft check go to zmx", async () => {
  const zmx = zmxFake();
  const { f, agterm, clock } = await startFlowd(makeHome({ ...STEP_FILES, ...ZMX }), { zmx });
  await f.submit(start("z"));
  await settle(f);
  await f.submit(status("zmx:Z1", "active"));
  await f.submit(report({ session: "zmx:Z1", outcome: "done" }));
  await f.submit(status("zmx:Z1", "completed"));
  zmx.sessions[0].overlay = true; // the fake's stand-in for "the user is typing"
  clock.t += 17_000;
  await settle(f);
  assert.deepEqual(zmx.typed(), []);
  zmx.sessions[0].overlay = false;
  await settle(f);
  assert.deepEqual(zmx.typed(), ["type zmx:Z1 ▶ flow: step c · z#1 it.1 — run `flow show` for the instructions"]);
  assert.deepEqual(agterm.typed(), []);
  await f.close();
});

test("a tick closes a zmx role whose session is gone; no zmx list while no run holds a zmx session", async () => {
  const zmx = zmxFake();
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO, ...ZMX }), { zmx });
  await f.submit(start("p"));
  await settle(f);
  await f.tickNow();
  assert.equal(zmx.trees, 0);
  await f.submit(start("z"));
  await settle(f);
  await f.tickNow();
  await settle(f);
  assert.equal(f.store.getRun("z#1")!.roles.pm, "zmx:Z1");
  zmx.sessions = [];
  await f.tickNow();
  await settle(f);
  assert.equal(f.store.getRun("z#1")!.roles.pm, null);
  assert.equal(f.store.getRun("p#1")!.roles.pm, "S1");
  await f.close();
});

test("at startup a zmx session is looked for in zmx, not agterm", async () => {
  const home = makeHome({ ...STEP_FILES, ...ZMX });
  const zmx = zmxFake();
  const A = await startFlowd(home, { zmx });
  await A.f.submit(start("z"));
  await settle(A.f);
  await A.f.close();
  const B = await startFlowd(home, { agterm: new FakeAgterm(), zmx });
  await settle(B.f);
  assert.equal(B.f.store.getRun("z#1")!.roles.pm, "zmx:Z1");
  await B.f.close();
  const C = await startFlowd(home, { agterm: new FakeAgterm(), zmx: zmxFake() });
  await settle(C.f);
  assert.equal(C.f.store.getRun("z#1")!.roles.pm, null);
  await C.f.close();
});

const hook = (session: string, event: string, claude?: string, source?: string) =>
  ({ type: "claude.status", data: { session, event, claude, source }, source: "claude" });

test("Claude hooks move a zmx session's turn; a nested claude's events are ignored; /clear moves the id", async () => {
  const zmx = zmxFake();
  const { f, clock } = await startFlowd(makeHome({ ...STEP_FILES, ...ZMX }), { zmx });
  await f.submit(start("z"));
  await settle(f);
  await f.submit(hook("zmx:Z1", "start", "c1", "startup"));
  await f.submit(hook("zmx:Z1", "active", "c1"));
  assert.equal(f.store.sessionStatus("zmx:Z1"), "active");
  await f.submit(hook("zmx:Z1", "start", "nested", "startup")); // a `claude -p` the agent ran
  await f.submit(hook("zmx:Z1", "completed", "nested"));
  assert.equal(f.store.sessionStatus("zmx:Z1"), "active");
  await f.submit(report({ session: "zmx:Z1", outcome: "done" }));
  await f.submit(hook("zmx:Z1", "completed", "c1"));
  assert.equal(f.store.sessionStatus("zmx:Z1"), "completed");
  clock.t += 17_000;
  await settle(f);
  assert.equal(zmx.typed().length, 1); // the next line went out once the turn ended
  await f.submit(hook("zmx:Z1", "start", "c2", "clear")); // the same agent after /clear
  await f.submit(hook("zmx:Z1", "blocked", "c2"));
  assert.equal(f.store.sessionStatus("zmx:Z1"), "blocked");
  await f.close();
});

test("Claude hook statuses for an agterm session are ignored: agterm reports those", async () => {
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  await f.submit(start("p", { pm: "S1" }));
  await f.submit(status("S1", "completed"));
  await f.submit(hook("S1", "active", "c1"));
  assert.equal(f.store.sessionStatus("S1"), "completed");
  await f.close();
});

test("each spawn of a zmx role gets its own session name: a respawn never types into the old agent", async () => {
  const zmx = zmxFake();
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...ZMX }), { zmx });
  await f.submit(start("z"));
  await settle(f);
  await f.submit({ type: "role.respawn", run: "z#1", data: { role: "pm" }, source: "ui" });
  await settle(f);
  const names = zmx.calls.filter((c) => c.startsWith("spawn")).map((c) => c.split(" | ")[1]);
  assert.equal(names.length, 2, zmx.calls.join("\n"));
  assert.notEqual(names[0], names[1]);
  assert.match(names[0], /^flows-z-1-pm-\d+$/);
  await f.close();
});

test("Claude idle at its prompt ends a turn flowd still thinks is active (a Stop missed while flowd was down, an Esc)", async () => {
  const zmx = zmxFake();
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...ZMX }), { zmx });
  await f.submit(start("z"));
  await settle(f);
  await f.submit(hook("zmx:Z1", "active", "c1"));
  await f.submit(hook("zmx:Z1", "idle", "c1"));
  assert.equal(f.store.sessionStatus("zmx:Z1"), "completed");
  await f.submit(hook("zmx:Z1", "blocked", "c1"));
  await f.submit(hook("zmx:Z1", "idle", "c1"));
  assert.equal(f.store.sessionStatus("zmx:Z1"), "blocked"); // idle heals only a stale active
  await f.close();
});

test("the agent's Claude id survives a flowd restart; a nested claude -p or --resume mid-turn cannot take it", async () => {
  const home = makeHome({ ...STEP_FILES, ...ZMX });
  const zmx = zmxFake();
  const A = await startFlowd(home, { zmx });
  await A.f.submit(start("z"));
  await settle(A.f);
  await A.f.submit(hook("zmx:Z1", "start", "c1", "startup"));
  await A.f.submit(hook("zmx:Z1", "active", "c1"));
  await A.f.close();
  const B = await startFlowd(home, { zmx });
  await settle(B.f);
  await B.f.submit(hook("zmx:Z1", "start", "nested", "startup"));
  await B.f.submit(hook("zmx:Z1", "completed", "nested"));
  await B.f.submit(hook("zmx:Z1", "start", "nested2", "resume"));
  await B.f.submit(hook("zmx:Z1", "completed", "nested2"));
  assert.equal(B.f.store.sessionStatus("zmx:Z1"), "active");
  await B.f.submit(hook("zmx:Z1", "completed", "c1"));
  assert.equal(B.f.store.sessionStatus("zmx:Z1"), "completed");
  await B.f.close();
});

test("a ping types the request into the waiting step's agent and leaves the run as it was", async () => {
  const { f, agterm, clock } = await startFlowd(makeHome({ ...STEP_FILES, ...proc("  - {step: c, role: pm, wait_for: test.ping}\n") }));
  agterm.addSession("S1");
  await f.submit({ type: "run.start", data: { process: "p", bind: { pm: "S1" }, vars: { pr: "https://github.com/o/r/pull/7" } }, source: "test" });
  await settle(f);
  assert.deepEqual(await f.submit({ type: "run.ping", run: "p#1", data: {}, source: "ui" }), { run: "p#1" });
  clock.t += 20_000;
  await settle(f);
  assert.ok(agterm.typed().some((c) => c.startsWith("type S1 ▶ flow: the user asks you to ping whoever p#1 is waiting on — step c has waited 0m for test.ping. PR: https://github.com/o/r/pull/7.")), agterm.typed().join("\n"));
  assert.equal(f.store.getRun("p#1")!.entries.c.status, "waiting");
  assert.match((await f.submit({ type: "run.ping", run: "p#9", data: {}, source: "ui" })).error ?? "", /p#9/);
  await f.close();
});

test("a finished run's Claude agent comes back in a new session, resuming its conversation", async () => {
  const home = makeHome({ ...STEP_FILES, ...proc("  - {step: b, role: pm}\n") });
  const projects = join(home, "claude-projects");
  const { f, agterm } = await startFlowd(home, { claudeProjects: projects });
  agterm.addSession("S9");
  await f.submit(start("p", { pm: "S9" }));
  await settle(f);
  await f.submit(report({ run: "p#1", entry: "b", outcome: "done", by: "human" }));
  assert.equal(f.store.getRun("p#1")!.status, "done");
  assert.deepEqual(f.runSummary(f.store.getRun("p#1")!).resumable, ["pm"]);
  // still open: nothing to restore, it is just shown
  assert.deepEqual(await f.restoreSession("p#1", "pm"), { session: "S9" });
  assert.ok(agterm.calls.includes("focus S9"));
  agterm.sessions = []; // the last step closed it
  assert.match((await f.restoreSession("p#1", "pm") as { error: string }).error, /no conversation of p#1 pm/);
  mkdirSync(join(projects, "-tmp"), { recursive: true });
  writeFileSync(join(projects, "-tmp", "c1.jsonl"), JSON.stringify({ type: "user", sessionId: "c1", cwd: "/tmp/w", timestamp: new Date().toISOString(),
    message: { content: "▶ flow: step b · p#1 it.1 — run `flow show` for the instructions" } }) + "\n");
  assert.deepEqual(await f.restoreSession("p#1", "pm"), { session: "S1" });
  assert.ok(agterm.calls.includes("spawn S1 p | p#1 pm (restored) | /tmp/w | claude --resume 'c1'"), agterm.calls.join("\n"));
  assert.ok(agterm.calls.includes("focus S1"));
  assert.equal(f.store.getRun("p#1")!.status, "done");
  assert.match((await f.restoreSession("p#1", "nope") as { error: string }).error, /no role nope/);
  await f.close();
});
