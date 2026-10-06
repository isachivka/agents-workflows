import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStep, parseProcess, parseDuration, loadDefs, writeDef, readDef, deleteDef, splitStep, DefError, type DefCtx } from "../src/defs.ts";

const step = (id: string) => parseStep(id, `---\nsummary: ${id} summary\n---\nDo ${id}.\n`);
const ctx: DefCtx = {
  steps: { pick: step("pick"), gate: step("gate"), merge: step("merge"), "fix-ci": step("fix-ci") },
  eventTypes: new Set(["gh.checks", "gh.merged", "flow.iteration.done"]),
  actionNames: new Set(["slack.post"]),
};
const errorsOf = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) { if (e instanceof DefError) return e.errors; throw e; }
  return [];
};

const GOOD = `
description: sample
cwd: ~/x
repeat: true
roles:
  pm: {spawn: "claude"}
triggers:
  - {cron: "0 10 * * 1-5"}
  - {on: flow.iteration.done, where: {process: other}}
steps:
  - {do: clear, role: pm}
  - {step: pick, role: pm}
  - {step: gate, role: pm, on_fail: {goto: pick}, retries: 2, timeout: 2h}
  - {id: ci, wait_for: gh.checks, on_fail: {goto: fix-ci}}
  - {step: merge, role: human, wait_for: gh.merged}
  - {step: fix-ci, role: pm, detour: true, after: {goto: ci}}
`;

test("parses a valid process into entries", () => {
  const p = parseProcess("pr-loop", GOOD, ctx);
  assert.equal(p.repeat, true);
  assert.equal(p.maxRuns, 1);
  assert.deepEqual(p.entries.map((e) => [e.id, e.kind]), [
    ["clear", "action"], ["pick", "agent"], ["gate", "agent"], ["ci", "wait"], ["merge", "human"], ["fix-ci", "agent"],
  ]);
  const gate = p.entries[2];
  assert.deepEqual(gate.onFail, { goto: "pick" });
  assert.equal(gate.retries, 2);
  assert.equal(gate.timeoutMs, 2 * 3600_000);
  assert.equal(p.entries[1].retries, 3);
  assert.equal(p.entries[1].onFail, "human");
  assert.deepEqual(p.entries[3].waitFor, { on: "gh.checks", where: {}, with: {} });
  assert.equal(p.entries[5].detour, true);
  assert.deepEqual(p.triggers[1], { on: "flow.iteration.done", where: { process: "other" }, with: {} });
});

test("collects every validation error at once", () => {
  const errs = errorsOf(() => parseProcess("bad", `
cwd: ""
bogus: 1
roles:
  human: {spawn: x}
  pm: {}
triggers:
  - {cron: "not a cron"}
  - {on: nope.thing}
steps:
  - {step: missing, role: pm}
  - {step: pick, role: ghost}
  - {do: compact}
  - {do: type, role: pm}
  - {wait_for: nope.event}
  - {step: gate, role: pm, on_fail: {goto: nowhere}}
  - {step: merge, role: pm, detour: true}
  - {step: pick, role: pm}
  - {}
  - {wait_for: {on: signal.x, where: [{env: prod}], with: [1]}}
  - {wait_for: signal.y, with: [1]}
`, ctx));
  for (const want of [
    /description is required/, /cwd is required/, /unknown key bogus/, /role name human is reserved/,
    /role pm: spawn is required/, /cron not a cron/, /unknown event type nope\.thing/,
    /steps\/missing\.md is missing or invalid/, /undeclared role ghost/, /do: compact needs a declared agent role/,
    /do: type needs text/, /unknown event type nope\.event/, /goto target nowhere does not exist/,
    /a detour needs after\.goto/, /duplicate entry id pick/, /needs step, do, wait_for, wait or sh/,
    /wait_for\.where must be a mapping/, /wait_for\.with must be a mapping/, /steps\[\d+\]: with must be a mapping/,
  ]) assert.ok(errs.some((e) => want.test(e)), `missing error ${want}: ${errs.join(" | ")}`);
});

test("signal.* event types need no plugin", () => {
  const p = parseProcess("s", `description: d\ncwd: /tmp\nsteps:\n  - {wait_for: signal.deploy-done}\n`, ctx);
  assert.equal(p.entries[0].kind, "wait");
});

test("only-detour processes are rejected", () => {
  const errs = errorsOf(() => parseProcess("d", `description: d\ncwd: /tmp\nroles: {pm: {spawn: c}}\nsteps:\n  - {step: pick, role: pm, detour: true, after: {goto: pick}}\n`, ctx));
  assert.ok(errs.some((e) => /at least one entry must not be a detour/.test(e)));
});

test("step files need frontmatter with summary and a body", () => {
  assert.deepEqual(errorsOf(() => parseStep("x", "no frontmatter")), ["missing --- frontmatter --- block"]);
  const errs = errorsOf(() => parseStep("x", "---\nfoo: 1\n---\n"));
  assert.ok(errs.includes("unknown key foo") && errs.includes("summary is required") && errs.includes("body is empty"));
  assert.deepEqual(splitStep("---\nsummary: s\n---\nbody\n"), { summary: "s", body: "body" });
  assert.deepEqual(splitStep("garbage"), { summary: "", body: "garbage" });
});

test("durations", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.throws(() => parseDuration("5 minutes"));
});

test("loadDefs keeps invalid files out and reports them", () => {
  const home = mkdtempSync(join(tmpdir(), "flows-defs-"));
  mkdirSync(join(home, "steps")); mkdirSync(join(home, "processes"));
  writeFileSync(join(home, "steps", "pick.md"), "---\nsummary: s\n---\nPick.\n");
  writeFileSync(join(home, "steps", "broken.md"), "nope");
  writeFileSync(join(home, "processes", "ok.yaml"), "description: d\ncwd: /tmp\nroles: {pm: {spawn: c}}\nsteps:\n  - {step: pick, role: pm}\n");
  writeFileSync(join(home, "processes", "bad.yaml"), "description: d\ncwd: /tmp\nsteps:\n  - {step: broken, role: pm}\n");
  const defs = loadDefs(home, new Set(), new Set());
  assert.deepEqual(Object.keys(defs.steps), ["pick"]);
  assert.deepEqual(Object.keys(defs.processes), ["ok"]);
  assert.ok(defs.invalid["step:broken"]);
  assert.ok(defs.invalid["process:bad"].some((e) => /steps\/broken\.md is missing or invalid/.test(e)));
});

test("writeDef validates, checks mtime and writes atomically", () => {
  const home = mkdtempSync(join(tmpdir(), "flows-write-"));
  const text = "---\nsummary: s\n---\nBody.\n";
  const first = writeDef(home, "step", "pick", text, null, ctx);
  assert.equal(first.ok, true);
  const stale = writeDef(home, "step", "pick", text, null, ctx);
  assert.deepEqual(stale, { ok: false, status: 409, errors: ["the file changed on disk; reload it"] });
  const bad = writeDef(home, "step", "pick", "nope", readDef(home, "step", "pick")!.mtime, ctx);
  assert.equal(bad.ok === false && bad.status, 422);
  const cur = readDef(home, "step", "pick")!;
  utimesSync(join(home, "steps", "pick.md"), new Date(), new Date(Date.now() + 5000));
  assert.equal(deleteDef(home, "step", "pick", cur.mtime).ok, false);
  assert.equal(deleteDef(home, "step", "pick", readDef(home, "step", "pick")!.mtime).ok, true);
  assert.equal(readDef(home, "step", "pick"), null);
});

test("an on: trigger takes a with mapping; cron does not", () => {
  const p = parseProcess("t", `description: d\ncwd: /tmp\ntriggers:\n  - {on: gh.merged, with: {base: main}, where: {author: me}}\nsteps:\n  - {wait_for: signal.x}\n`, ctx);
  assert.deepEqual(p.triggers[0], { on: "gh.merged", where: { author: "me" }, with: { base: "main" } });
  const errs = errorsOf(() => parseProcess("t", `description: d\ncwd: /tmp\ntriggers:\n  - {on: gh.merged, with: main}\n  - {cron: "0 10 * * *", with: {a: 1}}\nsteps:\n  - {wait_for: signal.x}\n`, ctx));
  assert.ok(errs.includes("trigger 1: with must be a mapping"), errs.join(" | "));
  assert.ok(errs.includes("trigger 2: with only applies to on: triggers"), errs.join(" | "));
});

test("a pause entry: wait with a duration, on its own", () => {
  const p = parseProcess("w", "description: d\ncwd: /tmp\nsteps:\n  - {wait: 2h}\n  - {id: tail, wait: 30s}\n", ctx);
  assert.deepEqual(p.entries.map((e) => [e.id, e.kind, e.delayMs]), [["wait", "delay", 7_200_000], ["tail", "delay", 30_000]]);
  const errs = errorsOf(() => parseProcess("w", "description: d\ncwd: /tmp\nroles: {pm: {spawn: c}}\nsteps:\n  - {wait: soon}\n  - {id: x, wait: 1m, step: pick, role: pm}\n  - {id: y, wait: 1m, wait_for: gh.merged}\n", ctx));
  assert.ok(errs.some((e) => /steps\[1\]: bad duration "soon"/.test(e)), errs.join(" | "));
  assert.ok(errs.includes("steps[2]: wait is a pause on its own; it cannot go with step, do or wait_for"), errs.join(" | "));
  assert.ok(errs.includes("steps[3]: wait is a pause on its own; it cannot go with step, do or wait_for"), errs.join(" | "));
});

test("a shell entry: sh with a command, on its own; cwd only beside sh", () => {
  const p = parseProcess("s", "description: d\ncwd: /tmp\nsteps:\n  - {sh: 'echo hi'}\n  - {id: two, sh: 'ls', cwd: '{{vars.dir}}', wait_for: signal.go}\n", ctx);
  assert.deepEqual(p.entries.map((e) => [e.id, e.kind, e.sh, e.cwd]), [["sh", "action", "echo hi", undefined], ["two", "action", "ls", "{{vars.dir}}"]]);
  const errs = errorsOf(() => parseProcess("s", "description: d\ncwd: /tmp\nroles: {pm: {spawn: c}}\nsteps:\n  - {sh: ''}\n  - {id: a, sh: ls, role: pm}\n  - {id: b, sh: ls, wait: 1m}\n  - {id: c, step: pick, role: pm, cwd: /x}\n", ctx));
  assert.ok(errs.includes("steps[1]: sh must be a command"), errs.join(" | "));
  assert.ok(errs.includes("steps[2]: sh runs on its own; it cannot go with step, do, wait or role"), errs.join(" | "));
  assert.ok(errs.includes("steps[3]: sh runs on its own; it cannot go with step, do, wait or role"), errs.join(" | "));
  assert.ok(errs.includes("steps[4]: cwd on a step is only for sh, and must be a path"), errs.join(" | "));
});
