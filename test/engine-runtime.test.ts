import { test } from "node:test";
import assert from "node:assert/strict";
import { Sim, rep, nudge, mkDefs } from "./helpers.ts";
import { renderPrompt, reminderText, step } from "../src/engine.ts";
import type { Input, Outcome } from "../src/types.ts";

const STEPS = { b: "Do B", c: "Do C", fix: "Fix it", d: "CI said {{event.outcome}} for {{event.data.pr}}" };
const ev = (type: string, data: Record<string, unknown> = {}, outcome?: Outcome, entry?: string): Input =>
  ({ kind: "event", event: { type, data, outcome, entry, source: "test" } });
const WAIT = `
description: d
cwd: /tmp
roles: {pm: {spawn: c}}
steps:
  - {id: ci, wait_for: {on: gh.checks, where: {pr: "7"}, with: {pr: "{{vars.pr}}"}}, on_fail: {goto: fix}}
  - {step: c, role: human, wait_for: gh.merged}
  - {step: fix, role: pm, detour: true, after: {goto: ci}}
`;
const LINEAR = `
description: d
cwd: /tmp
roles: {pm: {spawn: claude}, ex: {spawn: claude}}
steps:
  - {step: b, role: pm}
  - {step: c, role: ex}
`;
const ONE_ROLE = (steps: string) => `description: d\ncwd: /tmp\nroles: {pm: {spawn: c}}\nsteps:\n${steps}`;

test("a pure wait arms a rendered watch and the matching event closes it", () => {
  const s = new Sim(WAIT, STEPS).send({ kind: "set", vars: { pr: "7" } }).send({ kind: "start" });
  assert.equal(s.status("ci"), "waiting");
  assert.deepEqual(s.actions, [{ kind: "watch", entry: "ci", waitFor: { on: "gh.checks", where: { pr: "7" }, with: { pr: "7" } } }]);
  s.send(ev("gh.checks", { pr: "8" }, "done"));
  assert.equal(s.status("ci"), "waiting");
  assert.deepEqual(s.actions, []);
  s.send(ev("gh.checks", { pr: "7" }, "done", "other-entry"));
  assert.equal(s.status("ci"), "waiting");
  s.send(ev("gh.checks", { pr: "7" }, "done"));
  assert.equal(s.status("ci"), "done");
  assert.equal(s.run.current, "c");
  assert.ok(s.kinds().includes("unwatch"));
  assert.equal(s.status("c"), "waiting");
  s.send(ev("gh.merged", {}, "done"));
  assert.equal(s.run.status, "done");
});

test("a failed event takes on_fail and the detour returns to the wait", () => {
  const s = new Sim(WAIT, STEPS).send({ kind: "set", vars: { pr: "7" } }).send({ kind: "start" })
    .send(ev("gh.checks", { pr: "7", failed: ["lint"] }, "failed"));
  assert.equal(s.run.current, "fix");
  assert.deepEqual(s.delivered(), [nudge("pm", "fix")]);
  s.send(rep("fix"));
  assert.equal(s.run.current, "ci");
  assert.equal(s.status("ci"), "waiting");
  assert.ok(s.kinds().includes("watch"));
});

test("an agent step that waits gets the event in its prompt", () => {
  const s = new Sim(ONE_ROLE("  - {step: d, role: pm, wait_for: gh.checks}\n"), STEPS).send({ kind: "start" });
  assert.equal(s.status("d"), "waiting");
  assert.deepEqual(s.delivered(), []);
  s.send(ev("gh.checks", { pr: "7" }, "failed"));
  assert.equal(s.status("d"), "active");
  assert.deepEqual(s.delivered(), [nudge("pm", "d")]);
  assert.equal(renderPrompt(s.run, s.process!.entries[0], s.defs), "CI said failed for 7");
});

test("clear and compact on a bound role: /clear moves on, /compact waits for its session", () => {
  const s = new Sim(ONE_ROLE("  - {do: clear, role: pm}\n  - {do: compact, role: pm}\n  - {step: b, role: pm}\n"), STEPS, { pm: "S1" })
    .send({ kind: "start" });
  assert.deepEqual(s.delivered(), ["pm: /clear", "pm: /compact"]);
  assert.equal(s.status("clear"), "done");
  assert.equal(s.status("compact"), "active");
  s.send({ kind: "compacted", session: "S2" });
  assert.equal(s.status("compact"), "active");
  s.send({ kind: "compacted", session: "S1" });
  assert.equal(s.status("compact"), "done");
  assert.deepEqual(s.delivered(), [nudge("pm", "b")]);
});

test("clear and compact on a role without a session are no-ops", () => {
  const s = new Sim(ONE_ROLE("  - {do: clear, role: pm}\n  - {do: compact, role: pm}\n  - {step: b, role: pm}\n"), STEPS).send({ kind: "start" });
  assert.equal(s.run.entries.clear.note, "fresh session, no clear needed");
  assert.equal(s.status("compact"), "done");
  assert.deepEqual(s.delivered(), [nudge("pm", "b")]);
});

test("compact fails after 10 minutes without a report", () => {
  const s = new Sim(ONE_ROLE("  - {do: compact, role: pm}\n  - {step: b, role: pm}\n"), STEPS, { pm: "S1" }).send({ kind: "start" });
  s.now += 599_999;
  s.send({ kind: "tick" });
  assert.equal(s.status("compact"), "active");
  s.now += 1;
  s.send({ kind: "tick" });
  assert.equal(s.run.status, "needs-human");
  assert.equal(s.run.reason, "compact failed: timed out after 600s");
});

test("an agent that ends its turn without reporting is reminded twice, then the run halts", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  s.send({ kind: "session", session: "S1", status: "completed" });
  assert.equal(s.run.entries.b.remindAt, undefined);
  for (let i = 1; i <= 2; i++) {
    s.send({ kind: "session", session: "S1", status: "active" }).send({ kind: "session", session: "S1", status: "completed" });
    assert.equal(s.run.entries.b.remindAt, s.now + 30_000);
    s.now += 29_999;
    s.send({ kind: "tick" });
    assert.deepEqual(s.delivered(), []);
    s.now += 1;
    s.send({ kind: "tick" });
    assert.deepEqual(s.delivered(), [`pm: ${reminderText("b")}`]);
    assert.equal(s.run.entries.b.reminded, i);
  }
  s.send({ kind: "session", session: "S1", status: "active" }).send({ kind: "session", session: "S1", status: "idle" });
  s.now += 30_000;
  s.send({ kind: "tick" });
  assert.equal(s.run.status, "needs-human");
  assert.match(s.run.reason!, /ended its turn 3 times/);
});

test("blocked is not the end of a turn", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" })
    .send({ kind: "session", session: "S1", status: "active" }).send({ kind: "session", session: "S1", status: "blocked" });
  assert.equal(s.run.entries.b.remindAt, undefined);
});

test("a closed session unbinds its role; the run halts only if that role was mid-step", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1", ex: "S2" }).send({ kind: "start" });
  s.send({ kind: "session", session: "S2", status: "closed" });
  assert.equal(s.run.roles.ex, null);
  assert.equal(s.run.status, "running");
  s.send({ kind: "session", session: "S1", status: "closed" });
  assert.equal(s.run.roles.pm, null);
  assert.equal(s.run.status, "needs-human");
  assert.equal(s.run.reason, "role pm session closed");
  s.send({ kind: "respawn", role: "pm" });
  assert.equal(s.run.status, "running");
  assert.deepEqual(s.delivered(), [nudge("pm", "b")]);
});

test("a human rebind recovers the run; a spawn bind is silent", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" }).send({ kind: "session", session: "S1", status: "closed" });
  s.send({ kind: "bind", role: "pm", session: "S9", by: "human" });
  assert.equal(s.run.roles.pm, "S9");
  assert.equal(s.run.status, "running");
  assert.deepEqual(s.delivered(), [nudge("pm", "b")]);
  s.send({ kind: "bind", role: "ex", session: "S3", by: "spawn" });
  assert.deepEqual(s.actions, []);
  assert.match(s.send({ kind: "bind", role: "nope", session: "S4", by: "human" }).error!, /no role nope/);
});

test("rebinding a role that did not cause the halt leaves the run with the human", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1", ex: "S2" }).send({ kind: "start" });
  s.send(rep("b", "failed", "agent", "red"));
  assert.equal(s.run.status, "needs-human");
  s.send({ kind: "bind", role: "ex", session: "S3", by: "human" });
  assert.equal(s.run.roles.ex, "S3");
  assert.deepEqual([s.run.status, s.run.reason], ["needs-human", "b failed: red"]);
  s.send({ kind: "respawn", role: "pm" });
  assert.equal(s.run.status, "needs-human");
});

test("a role added by a definition edit can be bound in an open run", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  s.process = mkDefs(LINEAR.replace("ex: {spawn: claude}}", "ex: {spawn: claude}, qa: {spawn: claude}}"), STEPS).process;
  s.send({ kind: "bind", role: "qa", session: "S7", by: "spawn" });
  assert.equal(s.error, undefined);
  assert.equal(s.run.roles.qa, "S7");
});

test("timeouts fail waiting entries and drop their watch", () => {
  const s = new Sim(ONE_ROLE("  - {id: ci, wait_for: gh.checks, timeout: 1m}\n"), STEPS).send({ kind: "start" });
  s.now += 60_000;
  s.send({ kind: "tick" });
  assert.equal(s.status("ci"), "failed");
  assert.ok(s.kinds().includes("unwatch"));
  assert.equal(s.run.status, "needs-human");
});

test("type renders its text and moves on", () => {
  const s = new Sim(ONE_ROLE("  - {do: type, role: pm, text: \"hello {{vars.who}}\"}\n  - {step: b, role: pm}\n"), STEPS, { pm: "S1" })
    .send({ kind: "set", vars: { who: "x" } }).send({ kind: "start" });
  assert.deepEqual(s.delivered(), ["pm: hello x", nudge("pm", "b")]);
});

test("plugin actions are run by the daemon and reported by the system", () => {
  const s = new Sim(ONE_ROLE("  - {do: test.post, with: {msg: \"{{vars.m}}\"}}\n  - {step: b, role: pm}\n"), STEPS)
    .send({ kind: "set", vars: { m: "hi" } }).send({ kind: "start" });
  assert.deepEqual(s.actions, [{ kind: "plugin-action", entry: "test.post", name: "test.post", with: { msg: "hi" } }]);
  s.send(rep("test.post", "done", "system"));
  assert.equal(s.run.current, "b");
});

test("a missing process or a removed current entry stops the run for the human", () => {
  const s = new Sim(LINEAR, STEPS).send({ kind: "start" });
  const gone = step(s.run, { kind: "tick" }, { process: undefined, defs: s.defs, now: s.now });
  assert.equal(gone.run.status, "needs-human");
  assert.equal(gone.run.reason, "process p is invalid or missing");
  const edited = mkDefs("description: d\ncwd: /tmp\nroles: {ex: {spawn: c}}\nsteps:\n  - {step: c, role: ex}\n", STEPS);
  s.process = edited.process;
  s.defs = edited.defs;
  s.send({ kind: "tick" });
  assert.equal(s.run.status, "needs-human");
  assert.equal(s.run.reason, "entry b no longer exists");
  s.send({ kind: "goto", entry: "c" });
  assert.equal(s.run.status, "running");
  assert.equal(s.status("c"), "active");
});
const wait = (note = "review running", extra: Partial<{ human: boolean; sessionActive: boolean; entry: string }> = {}): Input =>
  ({ kind: "wait", entry: "b", note, human: false, sessionActive: true, ...extra });
const turn = (s: Sim, status: "active" | "completed" | "idle") => s.send({ kind: "session", session: "S1", status });

test("a wait declared mid-turn survives a repeated active, parks on the turn end, and is never reminded", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  turn(s, "active");
  s.send(wait());
  turn(s, "active");
  assert.equal(s.run.entries.b.wait?.parked, false);
  turn(s, "completed");
  assert.equal(s.run.entries.b.wait?.parked, true);
  assert.equal(s.run.entries.b.remindAt, undefined);
  turn(s, "idle");
  s.now += 600_000;
  s.send({ kind: "tick" });
  assert.deepEqual(s.delivered(), []);
  assert.equal(s.run.status, "running");
  assert.equal(s.run.entries.b.wait?.note, "review running");
});

test("the next turn uses the wait up; a later forgotten report is reminded as before", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  turn(s, "active");
  s.send(wait());
  turn(s, "completed");
  turn(s, "active");
  assert.equal(s.run.entries.b.wait, undefined);
  turn(s, "completed");
  assert.equal(s.run.entries.b.remindAt, s.now + 30_000);
  s.now += 30_000;
  s.send({ kind: "tick" });
  assert.deepEqual(s.delivered(), [`pm: ${reminderText("b")}`]);
});

test("waits reset the reminder count, so legitimate waits never halt a step", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  for (let i = 0; i < 2; i++) {
    turn(s, "active");
    turn(s, "completed");
    s.now += 30_000;
    s.send({ kind: "tick" });
  }
  assert.equal(s.run.entries.b.reminded, 2);
  for (let i = 0; i < 5; i++) {
    turn(s, "active");
    s.send(wait(`wait ${i}`));
    assert.equal(s.run.entries.b.reminded, 0);
    turn(s, "completed");
    s.now += 60_000;
    s.send({ kind: "tick" });
  }
  assert.equal(s.run.status, "running");
  assert.deepEqual(s.delivered(), []);
});

test("a wait from an idle session starts parked", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  s.send(wait("from my terminal", { sessionActive: false }));
  assert.equal(s.run.entries.b.wait?.parked, true);
  turn(s, "active");
  assert.equal(s.run.entries.b.wait, undefined);
});

test("the step's timeout still runs while its agent waits", () => {
  const s = new Sim("description: d\ncwd: /tmp\nroles: {pm: {spawn: c}}\nsteps:\n  - {step: b, role: pm, timeout: 1m}\n", STEPS, { pm: "S1" }).send({ kind: "start" });
  turn(s, "active");
  s.send(wait());
  turn(s, "completed");
  s.now += 60_000;
  s.send({ kind: "tick" });
  assert.equal(s.run.entries.b.status, "failed");
});

test("done, goto and retry leave no wait behind", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  s.send(wait());
  s.send({ kind: "retry", entry: "b" });
  assert.equal(s.run.entries.b.wait, undefined);
  s.send(wait());
  s.send(rep("b"));
  assert.equal(s.run.entries.b.wait, undefined);
});

test("flow wait is refused where a report would be, and needs a note", () => {
  const h = new Sim("description: d\ncwd: /tmp\nsteps:\n  - {step: c, role: human}\n", STEPS).send({ kind: "start" });
  assert.equal(h.send({ ...wait(), entry: "c" } as Input).error, "flow wait is for an agent's step; c is a human step");
  const s = new Sim(LINEAR, STEPS, { pm: "S1" });
  s.autoDeliver = false;
  s.send({ kind: "start" });
  assert.equal(s.send(wait()).error, "step b has not reached the agent yet");
  s.send({ kind: "delivered", entry: "b" });
  assert.equal(s.send(wait("")).error, "flow wait needs --note saying what you are waiting for");
  assert.match(s.send(wait("x", { entry: "c" })).error!, /not the current step/);
});

test("the reminder tells a forgetful agent about flow wait", () => {
  assert.match(reminderText("b"), /`flow wait --note "…"` if you are waiting on purpose/);
});
