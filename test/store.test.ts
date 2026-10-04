import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import type { RunState } from "../src/types.ts";

const run = (id: string, process = "p", extra: Partial<RunState> = {}): RunState => ({
  id, process, iteration: 1, status: "running", vars: {}, roles: { pm: null }, entries: {}, current: null, ...extra,
});

test("events are stored with their fields and processed in id order", () => {
  const s = new Store(":memory:");
  const a = s.addEvent({ type: "gh.checks", data: { pr: "7" }, outcome: "done", run: "p#1", entry: "ci", source: "gh" }, 10);
  const b = s.addEvent({ type: "signal.x", data: {}, source: "cli" }, 11);
  assert.deepEqual(s.event(a), { id: a, ts: 10, type: "gh.checks", data: { pr: "7" }, outcome: "done", run: "p#1", entry: "ci", source: "gh", processed: false });
  assert.deepEqual(s.unprocessed().map((e) => e.id), [a, b]);
  s.markProcessed(a);
  assert.deepEqual(s.unprocessed().map((e) => e.id), [b]);
  assert.equal(s.event(999), null);
});

test("runEvents finds events by run_id and by data.run, newest first", () => {
  const s = new Store(":memory:");
  s.addEvent({ type: "entry.report", run: "p#1", data: {}, source: "cli" });
  s.addEvent({ type: "flow.step.done", data: { run: "p#1", entry: "b" }, source: "flow" });
  s.addEvent({ type: "flow.step.done", data: { run: "p#2" }, source: "flow" });
  assert.deepEqual(s.runEvents("p#1").map((e) => e.type), ["flow.step.done", "entry.report"]);
});

test("runs: create, save, open vs finished, by session, numbering", () => {
  const s = new Store(":memory:");
  assert.equal(s.nextRunNumber("p"), 1);
  s.createRun(run("p#1", "p", { roles: { pm: "S1" } }), 1, 100);
  s.createRun(run("p#2"), 2, 200);
  assert.equal(s.nextRunNumber("p"), 3);
  assert.equal(s.nextRunNumber("q"), 1);
  const r2 = s.getRun("p#2")!;
  r2.status = "done";
  s.saveRun(r2, 300);
  assert.deepEqual(s.openRuns().map((r) => r.id), ["p#1"]);
  assert.deepEqual(s.listRuns().map((r) => r.id), ["p#1", "p#2"]);
  assert.deepEqual(s.runBySession("S1")?.role, "pm");
  assert.equal(s.runBySession("S2"), null);
  assert.equal(s.getRun("nope"), null);
  assert.throws(() => s.saveRun(run("ghost")), /no run ghost/);
});

test("outbox rows are pending until sent; attempts count; drop clears unsent rows of a run", () => {
  const s = new Store(":memory:");
  const a = s.enqueue("p#1", "pm", "one", "b", 1);
  const b = s.enqueue("p#1", "pm", "two", null, 2);
  s.enqueue("p#2", "ex", "three", null, 3);
  assert.deepEqual(s.pendingOutbox().map((r) => r.text), ["one", "two", "three"]);
  assert.equal(s.pendingOutbox()[0].entry_id, "b");
  assert.equal(s.bumpOutbox(a), 1);
  assert.equal(s.bumpOutbox(a), 2);
  s.markSent(a);
  s.dropOutbox("p#1");
  assert.deepEqual(s.pendingOutbox().map((r) => r.text), ["three"]);
  assert.ok(b > a);
});

test("session statuses upsert", () => {
  const s = new Store(":memory:");
  assert.equal(s.sessionStatus("S1"), null);
  s.setSessionStatus("S1", "active", 1);
  s.setSessionStatus("S1", "completed", 2);
  assert.equal(s.sessionStatus("S1"), "completed");
});

test("tx rolls back on throw and joins nested calls", () => {
  const s = new Store(":memory:");
  assert.throws(() => s.tx(() => {
    s.tx(() => s.enqueue("p#1", "pm", "x"));
    throw new Error("boom");
  }), /boom/);
  assert.deepEqual(s.pendingOutbox(), []);
  s.tx(() => s.enqueue("p#1", "pm", "y"));
  assert.equal(s.pendingOutbox().length, 1);
});

test("a file database survives reopening", () => {
  const path = join(mkdtempSync(join(tmpdir(), "flows-store-")), "sub", "flows.db");
  const s = new Store(path);
  s.createRun(run("p#1"), 1);
  s.close();
  assert.equal(new Store(path).getRun("p#1")?.id, "p#1");
});
