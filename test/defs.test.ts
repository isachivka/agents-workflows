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
  const p = parseProcess("ts-wave", GOOD, ctx);
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
  assert.deepEqual(p.triggers[1], { on: "flow.iteration.done", where: { process: "other" } });
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
`, ctx));
  for (const want of [
    /description is required/, /cwd is required/, /unknown key bogus/, /role name human is reserved/,
    /role pm: spawn is required/, /cron not a cron/, /unknown event type nope\.thing/,
    /steps\/missing\.md is missing or invalid/, /undeclared role ghost/, /do: compact needs a declared agent role/,
    /do: type needs text/, /unknown event type nope\.event/, /goto target nowhere does not exist/,
    /a detour needs after\.goto/, /duplicate entry id pick/, /needs step, do or wait_for/,
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
