import { test } from "node:test";
import assert from "node:assert/strict";
import { Sim, rep, nudge } from "./helpers.ts";

const STEPS = { a: "Do A in {{vars.dir}}", b: "Do B", c: "Do C", fix: "Fix it" };
const LINEAR = `
description: d
cwd: /tmp
roles: {pm: {spawn: claude}, ex: {spawn: claude}}
steps:
  - {step: b, role: pm}
  - {step: c, role: ex}
`;
const ONE_ROLE = (steps: string, extra = "") => `description: d\ncwd: /tmp\n${extra}roles: {pm: {spawn: c}}\nsteps:\n${steps}`;

test("start delivers the first agent step's nudge to its role", () => {
  const s = new Sim(LINEAR, STEPS).send({ kind: "start" });
  assert.equal(s.run.current, "b");
  assert.equal(s.status("b"), "active");
  assert.equal(s.run.entries.b.attempts, 1);
  assert.deepEqual(s.delivered(), [nudge("pm", "b")]);
  assert.match(new Sim(LINEAR, STEPS).send({ kind: "start" }).send({ kind: "start" }).error!, /already started/);
});

test("done advances to the next entry and emits flow.step.done", () => {
  const s = new Sim(LINEAR, STEPS).send({ kind: "start" }).send(rep("b", "done", "agent", "ok"));
  assert.equal(s.status("b"), "done");
  assert.equal(s.run.entries.b.note, "ok");
  assert.equal(s.run.current, "c");
  assert.deepEqual(s.delivered(), [nudge("ex", "c")]);
  assert.deepEqual(s.emitted(), ["flow.step.done"]);
});

test("the last entry of a non-repeating process finishes the run", () => {
  const s = new Sim(LINEAR, STEPS).send({ kind: "start" }).send(rep("b")).send(rep("c"));
  assert.equal(s.run.status, "done");
  assert.equal(s.run.current, null);
  assert.deepEqual(s.emitted(), ["flow.step.done", "flow.run.done"]);
  assert.match(s.send(rep("c")).error!, /run p#1 is done/);
});

test("a repeating process starts the next iteration with fresh entries and vars", () => {
  const s = new Sim(LINEAR.replace("cwd: /tmp", "cwd: /tmp\nrepeat: true"), STEPS)
    .send({ kind: "start" }).send({ kind: "set", vars: { x: "1" } }).send(rep("b")).send(rep("c"));
  assert.equal(s.run.iteration, 2);
  assert.deepEqual(s.run.vars, {});
  assert.equal(s.run.current, "b");
  assert.equal(s.status("c"), "pending");
  assert.ok(s.emitted().includes("flow.iteration.done"));
  assert.deepEqual(s.delivered(), [nudge("pm", "b", 2)]);
});

test("a failure with the default on_fail stops for the human; the human's done moves on", () => {
  const s = new Sim(LINEAR, STEPS).send({ kind: "start" }).send(rep("b", "failed", "agent", "red"));
  assert.equal(s.run.status, "needs-human");
  assert.equal(s.run.reason, "b failed: red");
  assert.equal(s.status("b"), "failed");
  assert.ok(s.emitted().includes("flow.run.needs-human"));
  s.send(rep("b", "done", "human"));
  assert.equal(s.run.status, "running");
  assert.equal(s.run.reason, undefined);
  assert.equal(s.run.current, "c");
});

test("on_fail retry re-delivers until retries run out", () => {
  const s = new Sim(ONE_ROLE("  - {step: b, role: pm, on_fail: retry, retries: 1}\n"), STEPS).send({ kind: "start" });
  s.send(rep("b", "failed", "agent", "x"));
  assert.equal(s.status("b"), "active");
  assert.equal(s.run.entries.b.attempts, 2);
  assert.deepEqual(s.delivered(), [nudge("pm", "b")]);
  s.send(rep("b", "failed", "agent", "y"));
  assert.equal(s.run.status, "needs-human");
  assert.equal(s.run.reason, "b failed 2 times: y");
});

test("on_fail goto resets the range and re-enters the target, keeping counts", () => {
  const s = new Sim(ONE_ROLE("  - {step: a, role: pm}\n  - {step: b, role: pm}\n  - {step: c, role: pm, on_fail: {goto: b}}\n"), STEPS)
    .send({ kind: "set", vars: { dir: "/w" } }).send({ kind: "start" })
    .send(rep("a")).send(rep("b")).send(rep("c", "failed", "agent", "gate red"));
  assert.equal(s.run.current, "b");
  assert.equal(s.status("a"), "done");
  assert.equal(s.status("b"), "active");
  assert.equal(s.status("c"), "pending");
  assert.equal(s.run.entries.c.failures, 1);
  assert.equal(s.run.entries.b.attempts, 2);
});

test("detours are skipped by advancing and return with after.goto", () => {
  const s = new Sim(ONE_ROLE("  - {step: a, role: pm, on_fail: {goto: fix}}\n  - {step: b, role: pm}\n  - {step: fix, role: pm, detour: true, after: {goto: a}}\n"), STEPS)
    .send({ kind: "set", vars: { dir: "/w" } }).send({ kind: "start" }).send(rep("a", "failed", "agent", "red"));
  assert.equal(s.run.current, "fix");
  assert.deepEqual(s.delivered(), [nudge("pm", "fix")]);
  s.send(rep("fix"));
  assert.equal(s.run.current, "a");
  assert.equal(s.status("fix"), "pending");
  assert.equal(s.run.entries.a.failures, 1);
  s.send(rep("a")).send(rep("b"));
  assert.equal(s.run.status, "done");
});

test("bad reports are refused and leave the run untouched", () => {
  const s = new Sim(LINEAR, STEPS).send({ kind: "start" }).send(rep("b"));
  const before = structuredClone(s.run);
  s.send(rep("b"));
  assert.equal(s.error, "step b is not the current step (current: c)");
  assert.deepEqual(s.run, before);
  assert.deepEqual(s.actions, []);
  s.send(rep("c", "failed", "agent"));
  assert.equal(s.error, "a failure needs --note");
  s.send({ kind: "skip", entry: "c", note: "" });
  assert.equal(s.error, "a skip needs a reason");
  assert.deepEqual(s.run, before);
});

test("an agent cannot close a step whose nudge has not been typed to it yet", () => {
  const s = new Sim(LINEAR, STEPS);
  s.autoDeliver = false;
  s.send({ kind: "start" });
  assert.equal(s.send(rep("b")).error, "step b has not reached the agent yet");
  s.send({ kind: "delivered", entry: "b" }).send(rep("b"));
  assert.equal(s.run.current, "c");
  assert.equal(s.send(rep("c")).error, "step c has not reached the agent yet");
});

test("only the human closes a human step", () => {
  const s = new Sim("description: d\ncwd: /tmp\nsteps:\n  - {step: c, role: human}\n", STEPS).send({ kind: "start" });
  assert.deepEqual(s.delivered(), []);
  assert.equal(s.status("c"), "active");
  s.send(rep("c"));
  assert.equal(s.error, "c is the human's step; a human closes it");
  s.send(rep("c", "done", "human"));
  assert.equal(s.run.status, "done");
});

test("a template error stops the run for the human instead of delivering", () => {
  const s = new Sim(ONE_ROLE("  - {step: a, role: pm}\n"), STEPS).send({ kind: "start" });
  assert.equal(s.run.status, "needs-human");
  assert.equal(s.run.reason, "a: {{vars.dir}} has no value");
  assert.deepEqual(s.delivered(), []);
});

test("skip, goto and retry are the human's overrides", () => {
  const s = new Sim(LINEAR, STEPS).send({ kind: "start" });
  s.send({ kind: "skip", entry: "b", note: "done by hand" });
  assert.equal(s.status("b"), "skipped");
  assert.equal(s.run.current, "c");
  s.send({ kind: "goto", entry: "b" });
  assert.equal(s.run.current, "b");
  assert.equal(s.status("c"), "pending");
  assert.deepEqual(s.delivered(), [nudge("pm", "b")]);
  s.send({ kind: "retry", entry: "b" });
  assert.equal(s.run.entries.b.attempts, 3); // start, goto, retry
  assert.match(s.send({ kind: "goto", entry: "zzz" }).error!, /no entry zzz/);
  assert.match(s.send({ kind: "retry", entry: "c" }).error!, /not the current step/);
});

test("pause, resume and stop", () => {
  const s = new Sim(LINEAR, STEPS).send({ kind: "start" }).send({ kind: "pause" });
  assert.equal(s.run.status, "paused");
  assert.match(s.send({ kind: "pause" }).error!, /only a running run can be paused/);
  s.send({ kind: "resume" });
  assert.equal(s.run.status, "running");
  assert.match(s.send({ kind: "resume" }).error!, /is not paused/);
  s.send({ kind: "stop" });
  assert.equal(s.run.status, "stopped");
  assert.equal(s.send({ kind: "start" }).error, "run p#1 is stopped");
});

test("a repeating iteration that does no work halts instead of looping forever", () => {
  const s = new Sim(ONE_ROLE("  - {do: clear, role: pm}\n", "repeat: true\n"), STEPS).send({ kind: "start" });
  assert.equal(s.run.status, "needs-human");
  assert.match(s.run.reason!, /did no work/);
});
