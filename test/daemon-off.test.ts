import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHome, proc, settle, startFlowd, STEP_FILES } from "./daemon-helpers.ts";

// b, then a wait for signal.go, then c; up to five runs at once
const W = proc("  - {step: b, role: pm}\n  - {wait_for: signal.go}\n  - {step: c, role: pm}\n", "max_runs: 5\ntriggers: [{on: signal.new}]\n", "w");
const ESC = 'press S1 "\\u001b"';
const status = (session: string, s: string) => ({ type: "agterm.status", data: { session, status: s }, source: "agterm" });
const start = (bind: Record<string, string> = {}, trigger?: string) => ({ type: "run.start", data: { process: "w", bind, ...(trigger ? { trigger } : {}) }, source: trigger === "cron" ? "cron" : "test" });

async function twoRuns() {
  const home = makeHome({ ...STEP_FILES, ...W });
  const t = await startFlowd(home, { pauseKeyDelayMs: 0 });
  t.agterm.addSession("S1");
  t.agterm.addSession("S2");
  await t.f.submit(start({ pm: "S1" }));
  await t.f.submit(start({ pm: "S2" }));
  await settle(t.f);
  return { ...t, home };
}

test("off pauses the running runs as the switch's, stops an agent mid-turn, leaves an idle one and a run the person paused alone", async () => {
  const { f, agterm } = await twoRuns();
  await f.submit(status("S1", "active"));
  await f.submit(status("S2", "completed"));
  await f.submit({ type: "run.pause", run: "w#2", data: {}, source: "ui" });
  await settle(f);
  const typedBefore = agterm.typed().length;
  await f.turnOff();
  await settle(f);
  assert.ok(f.offSince() !== null);
  assert.deepEqual([f.store.getRun("w#1")!.status, f.store.getRun("w#1")!.pausedBy], ["paused", "off"]);
  assert.deepEqual([f.store.getRun("w#2")!.status, f.store.getRun("w#2")!.pausedBy], ["paused", undefined]);
  assert.equal(agterm.calls.filter((c) => c === ESC).length, 1);
  const typed = agterm.typed().slice(typedBefore);
  assert.equal(typed.length, 1, typed.join("\n"));
  assert.match(typed[0], /^type S1 ▶ flow: w#1 is paused: flows is off\. Stop now/);
  // an agent that starts a turn in a run the switch paused is stopped too, once
  await f.submit(status("S2", "active"));
  await settle(f);
  assert.ok(!agterm.calls.includes('press S2 "\\u001b"'), "w#2 was paused by the person, not the switch");
  await f.close();
});

test("while off nothing new starts: a schedule is skipped for good, a start by hand queues, an event that starts a run is kept; on starts those", async () => {
  const { f } = await twoRuns();
  await f.turnOff();
  const cron = await f.submit(start({}, "cron"));
  assert.ok(cron.error, "a schedule that comes due while off is not run");
  const hand = await f.submit(start());
  assert.equal(hand.queued?.position, 1);
  await f.submit({ type: "signal.new", data: {}, source: "cli" });
  await settle(f);
  assert.deepEqual(f.store.openRuns().filter((r) => r.status === "queued").map((r) => r.id), ["w#3"]);
  assert.ok(f.store.unprocessed().some((e) => e.type === "signal.new"));
  // the skip is said (as flow.trigger.skipped), and kept like any event until flowd is on
  assert.ok(f.store.unprocessed().some((e) => e.type === "flow.trigger.skipped"));
  await f.turnOn();
  await settle(f);
  const open = f.store.openRuns();
  assert.deepEqual(open.filter((r) => r.status === "queued").map((r) => r.id), []);
  assert.equal(open.length, 4, "the skipped schedule did not start later");
  await f.close();
});

test("an event for a run while off is kept; on, the run goes on from it, and an agent stopped mid-step is told to carry on", async () => {
  const { f, agterm } = await twoRuns();
  // w#1 finishes b and waits for signal.go; w#2's agent is mid-turn on b
  await f.submit(status("S1", "active"));
  await f.submit({ type: "entry.report", data: { session: "S1", outcome: "done", by: "agent" }, source: "cli" });
  await f.submit(status("S1", "completed"));
  await f.submit(status("S2", "active"));
  await settle(f);
  const waitAt = f.store.getRun("w#1")!.current!;
  assert.ok(waitAt && waitAt !== "b" && waitAt !== "c", waitAt);
  await f.turnOff();
  await settle(f);
  await f.submit({ type: "signal.go", data: {}, source: "cli" });
  // the agent stopped by Esc reports anyway: kept as well
  await f.submit({ type: "entry.report", data: { session: "S2", outcome: "done", by: "agent" }, source: "cli" });
  await f.submit(status("S2", "completed"));
  await settle(f);
  assert.equal(f.store.getRun("w#1")!.current, waitAt, "nothing moves while off");
  assert.equal(f.store.getRun("w#2")!.current, "b");
  await f.turnOn();
  await settle(f);
  assert.equal(f.store.getRun("w#1")!.current, "c");
  assert.equal(f.store.getRun("w#2")!.current, waitAt);
  assert.deepEqual([f.store.getRun("w#1")!.status, f.store.getRun("w#2")!.status], ["running", "running"]);
  // w#2's step was closed by the kept report: no carry-on line for a step that is over
  assert.ok(!agterm.typed().some((x) => x.startsWith("type S2 ▶ flow: w#2 goes on")), agterm.typed().join("\n"));
  await f.close();
});

test("on: an agent stopped mid-step gets the carry-on line; a run the person paused stays paused", async () => {
  const { f, agterm, clock } = await twoRuns();
  await f.submit(status("S1", "active"));
  await f.submit({ type: "run.pause", run: "w#2", data: {}, source: "ui" });
  await settle(f);
  await f.turnOff();
  await f.submit(status("S1", "completed"));
  await settle(f);
  await f.turnOn();
  clock.t += 5_000;
  await settle(f);
  assert.equal(f.offSince(), null);
  assert.match(agterm.typed().at(-1)!, /^type S1 ▶ flow: w#1 goes on: flows is on again\. Carry on with step b from where you stopped/);
  assert.equal(f.store.getRun("w#2")!.status, "paused");
  await f.close();
});

test("off survives a restart: the switch's runs stay paused, starts still queue, on resumes them", async () => {
  const { f, home, agterm } = await twoRuns();
  await f.turnOff();
  await settle(f);
  await f.close();
  const b = await startFlowd(home, { pauseKeyDelayMs: 0, agterm });
  await settle(b.f);
  assert.ok(b.f.offSince() !== null);
  assert.equal(b.f.store.getRun("w#1")!.status, "paused");
  assert.equal((await b.f.submit(start())).queued?.position, 1);
  await b.f.turnOn();
  await settle(b.f);
  assert.deepEqual(b.f.store.openRuns().map((r) => r.status), ["running", "running", "running"]);
  await b.f.close();
});
