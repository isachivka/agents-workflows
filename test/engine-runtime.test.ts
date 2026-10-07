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
  s.send({ kind: "session", session: "S1", status: "active" }).send({ kind: "session", session: "S1", status: "completed" });
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

const START = 120_000;

test("a delivered line that never starts a turn stops the run after 2 min, naming the step", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  s.now += START - 1;
  s.send({ kind: "tick" });
  assert.equal(s.run.status, "running");
  s.now += 1;
  s.send({ kind: "tick" });
  assert.equal(s.run.status, "needs-human");
  assert.equal(s.run.reason, "b: the agent has not started 2 min after its line was delivered — look at its terminal (a trust or login prompt, an error)");
  assert.equal(s.run.startBlocked, "b");
});

test("an agent that starts in time, or waits on purpose, is not stopped", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  turn(s, "active");
  s.now += START * 3;
  s.send({ kind: "tick" });
  assert.equal(s.run.status, "running");
  const w = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  w.send(wait("from my terminal", { sessionActive: false }));
  w.now += START * 3;
  w.send({ kind: "tick" });
  assert.equal(w.run.status, "running");
});

test("a reminder that never starts a turn stops the run too", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  turn(s, "active");
  turn(s, "completed");
  s.now += 30_000;
  s.send({ kind: "tick" });
  assert.deepEqual(s.delivered(), [`pm: ${reminderText("b")}`]);
  s.now += START;
  s.send({ kind: "tick" });
  assert.equal(s.run.startBlocked, "b");
});

test("the agent's first active resumes a start-blocked run; other stops are not resumed", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  s.send({ kind: "start-blocked", entry: "b", reason: "b: trust prompt" });
  assert.deepEqual([s.run.status, s.run.reason, s.run.startBlocked], ["needs-human", "b: trust prompt", "b"]);
  turn(s, "active");
  assert.deepEqual([s.run.status, s.run.reason, s.run.startBlocked], ["running", undefined, undefined]);
  s.send({ kind: "halt", reason: "something else" });
  turn(s, "active");
  assert.equal(s.run.status, "needs-human");
});

test("a start block names only the current step", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  s.send({ kind: "start-blocked", entry: "c", reason: "x" });
  assert.equal(s.run.status, "running");
});

test("idle is not a turn end: it arms no reminder and parks no wait", () => {
  const s = new Sim(LINEAR, STEPS, { pm: "S1" }).send({ kind: "start" });
  turn(s, "active");
  turn(s, "idle");
  assert.equal(s.run.entries.b.remindAt, undefined);
  s.now += 60_000;
  s.send({ kind: "tick" });
  assert.deepEqual(s.delivered(), []);
  s.send(wait());
  turn(s, "idle");
  assert.equal(s.run.entries.b.wait?.parked, false);
  turn(s, "completed");
  assert.equal(s.run.entries.b.wait?.parked, true);
});

test("a re-armed wait carries the event that last woke its entry, through retry and goto; a first arm does not", () => {
  const s = new Sim(ONE_ROLE("  - {step: b, role: pm, wait_for: test.ping, on_fail: retry}\n  - {step: c, role: pm}\n"), STEPS, { pm: "S1" }).send({ kind: "start" });
  const watchOf = () => s.actions.find((a) => a.kind === "watch") as { previous?: unknown } | undefined;
  assert.equal(watchOf()?.previous, undefined);
  s.send(ev("test.ping", { id: "R1", by: "alice" }));
  assert.equal(s.status("b"), "active");
  s.send(rep("b", "failed", "agent", "waiting for re-review"));
  assert.deepEqual(watchOf()?.previous, { type: "test.ping", data: { id: "R1", by: "alice" } });
  s.send({ kind: "goto", entry: "b" });
  assert.deepEqual(watchOf()?.previous, { type: "test.ping", data: { id: "R1", by: "alice" } });
});

test("a pure decision wait sent to a fix detour and back is not handed a fresh start: it keeps what woke it", () => {
  const s = new Sim(ONE_ROLE("  - {id: approval, wait_for: test.ping, on_fail: {goto: fix}}\n  - {step: c, role: pm}\n  - {step: b, role: pm, id: fix, detour: true, after: {goto: approval}}\n"), STEPS, { pm: "S1" }).send({ kind: "start" });
  const watchOf = () => s.actions.find((a) => a.kind === "watch") as { previous?: unknown } | undefined;
  s.send(ev("test.ping", { id: "R1", state: "CHANGES_REQUESTED" }, "failed"));
  assert.equal(s.run.current, "fix");
  s.send(rep("fix"));
  assert.equal(s.run.current, "approval");
  assert.deepEqual(watchOf()?.previous, { type: "test.ping", data: { id: "R1", state: "CHANGES_REQUESTED" } });
});

test("a new iteration starts its waits with nothing that woke them before", () => {
  const s = new Sim("description: d\ncwd: /tmp\nrepeat: true\nroles: {pm: {spawn: c}}\nsteps:\n  - {id: w, wait_for: test.ping}\n  - {step: c, role: pm}\n", STEPS, { pm: "S1" }).send({ kind: "start" });
  s.send(ev("test.ping", { id: "R1" }));
  s.send(rep("c"));
  assert.equal(s.run.iteration, 2);
  const w = s.actions.find((a) => a.kind === "watch") as { previous?: unknown } | undefined;
  assert.ok(w, "iteration 2 armed its wait");
  assert.equal(w!.previous, undefined);
});

const PAUSE = `description: d\ncwd: /tmp\nroles: {pm: {spawn: c}}\nsteps:\n  - {step: b, role: pm}\n  - {id: tail, wait: 1h}\n  - {step: c, role: pm}\n`;

test("a pause waits for its time, arms no watch, then moves on", () => {
  const s = new Sim(PAUSE, STEPS, { pm: "S1" }).send({ kind: "start" }).send(rep("b"));
  assert.equal(s.status("tail"), "waiting");
  assert.ok(!s.kinds().includes("watch"));
  s.now += 3_599_999;
  s.send({ kind: "tick" });
  assert.equal(s.status("tail"), "waiting");
  s.now += 1;
  s.send({ kind: "tick" });
  assert.equal(s.status("tail"), "done");
  assert.equal(s.run.entries.tail.note, "waited 1h");
  assert.equal(s.run.current, "c");
});

test("a human can end a pause early or restart it", () => {
  const s = new Sim(PAUSE, STEPS, { pm: "S1" }).send({ kind: "start" }).send(rep("b"));
  s.now += 1_800_000;
  s.send({ kind: "retry", entry: "tail" });
  s.now += 3_000_000;
  s.send({ kind: "tick" });
  assert.equal(s.status("tail"), "waiting", "retry restarted the clock");
  s.send(rep("tail", "done", "human"));
  assert.equal(s.run.current, "c");
});

test("a pause that ran out while the run was paused closes on the first tick after resume", () => {
  const s = new Sim(PAUSE, STEPS, { pm: "S1" }).send({ kind: "start" }).send(rep("b")).send({ kind: "pause" });
  s.now += 7_200_000;
  s.send({ kind: "tick" });
  assert.equal(s.status("tail"), "waiting");
  s.send({ kind: "resume" }).send({ kind: "tick" });
  assert.equal(s.status("tail"), "done");
});

test("a shell entry hands the daemon the command as written, the cwd and the run as environment", () => {
  const s = new Sim("description: d\ncwd: /work\nroles: {pm: {spawn: c}}\nsteps:\n  - {id: mk, sh: 'echo \"$FLOW_VAR_PR\" {{not-a-template}}', cwd: '/w/{{vars.dir}}', wait_for: signal.go, timeout: 5m}\n  - {step: b, role: pm}\n", STEPS);
  s.send({ kind: "set", vars: { pr: "https://x/pull/1", "dir": "d1", "my-key": "v" } }).send({ kind: "start" });
  s.send({ kind: "event", event: { type: "signal.go", data: { title: "a; rm -rf /", n: 3, list: [1] }, source: "test" } });
  const a = s.actions.find((x) => x.kind === "shell") as any;
  assert.equal(a.command, 'echo "$FLOW_VAR_PR" {{not-a-template}}');
  assert.equal(a.cwd, "/w/d1");
  assert.equal(a.timeoutMs, 300_000);
  assert.deepEqual(a.env, {
    FLOW_RUN: "p#1", FLOW_PROCESS: "p", FLOW_ITERATION: "1",
    FLOW_VAR_PR: "https://x/pull/1", FLOW_VAR_DIR: "d1", FLOW_VAR_MY_KEY: "v",
    FLOW_EVENT_TITLE: "a; rm -rf /", FLOW_EVENT_N: "3",
  });
  const plain = new Sim("description: d\ncwd: /work\nsteps:\n  - {sh: 'true'}\n", STEPS).send({ kind: "start" });
  assert.deepEqual((plain.actions.find((x) => x.kind === "shell") as any).cwd, "/work");
  assert.equal((plain.actions.find((x) => x.kind === "shell") as any).timeoutMs, 1_800_000);
});

test("an agent closes its own step while it waits again, once the step has reached it; never a fresh one", () => {
  const s = new Sim(ONE_ROLE("  - {step: b, role: pm}\n  - {step: d, role: pm, wait_for: gh.checks, on_fail: retry}\n  - {step: c, role: pm}\n"), STEPS).send({ kind: "start" });
  s.send(rep("b"));
  assert.equal(s.status("d"), "waiting");
  s.send(rep("d"));
  assert.equal(s.error, "step d waits for gh.checks and has not reached you yet");
  s.send(ev("gh.checks", { pr: "7" }, "failed")).send(rep("d", "failed", "agent", "waiting for the next review"));
  assert.equal(s.status("d"), "waiting");
  s.send(rep("d", "done", "agent", "the user merged it by hand"));
  assert.equal(s.error, undefined);
  assert.equal(s.run.current, "c");
  assert.ok(s.kinds().includes("unwatch"));
});
