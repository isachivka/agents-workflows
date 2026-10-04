import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDefs } from "../src/check.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function home(files: Record<string, string>): string {
  const h = mkdtempSync(join(tmpdir(), "flows-check-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(h, rel)), { recursive: true });
    writeFileSync(join(h, rel), text);
  }
  return h;
}

const STEP = "---\nsummary: s\n---\nDo it.\n";
const GOOD = {
  "steps/a.md": STEP,
  "processes/ok.yaml": "description: d\ncwd: /tmp\nroles: {dev: {spawn: claude}}\nsteps:\n  - {step: a, role: dev}\n  - {id: ci, wait_for: gh.checks}\n",
};

test("a valid home reports counts and passes, gh events included", async () => {
  assert.deepEqual(await checkDefs(home(GOOD)), { ok: true, lines: ["1 process(es) and 1 step(s) are valid"] });
});

test("every problem gets its own line, prefixed with what it belongs to", async () => {
  const r = await checkDefs(home({
    ...GOOD,
    "steps/bad.md": "no frontmatter",
    "processes/broken.yaml": "description: d\ncwd: /tmp\nroles: {dev: {spawn: claude}}\nsteps:\n  - {do: clear, role: dev}\n  - {do: clear, role: dev}\n  - {step: a, role: lead}\n  - {step: a, role: dev, detour: true}\n",
  }));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("step bad: missing --- frontmatter --- block"), r.lines.join("\n"));
  for (const want of [/^process broken: duplicate entry id clear/, /^process broken: steps\[3\]: undeclared role lead/, /^process broken: steps\[4\]: a detour needs after\.goto/]) {
    assert.ok(r.lines.some((l) => want.test(l)), `${want}\n${r.lines.join("\n")}`);
  }
});

test("a name narrows the report; an unknown name is an error", async () => {
  const h = home({ ...GOOD, "steps/bad.md": "no frontmatter" });
  assert.deepEqual(await checkDefs(h, "ok"), { ok: true, lines: ["ok is valid"] });
  assert.deepEqual(await checkDefs(h, "a"), { ok: true, lines: ["a is valid"] });
  assert.deepEqual(await checkDefs(h, "bad"), { ok: false, lines: ["step bad: missing --- frontmatter --- block"] });
  assert.deepEqual(await checkDefs(h, "nope"), { ok: false, lines: ["no process or step named nope"] });
});

test("a user plugin that fails to load is reported", async () => {
  const r = await checkDefs(home({ ...GOOD, "plugins/broken.ts": "export default 42;\n" }));
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("plugin broken: ")), r.lines.join("\n"));
});

test("flow check runs without flowd and sets the exit code", async () => {
  const run = (h: string, args: string[]) => new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(process.execPath, [CLI, "check", ...args], { env: { ...process.env, FLOWS_HOME: h, FLOWD_URL: "http://127.0.0.1:9", AGTERM_SESSION_ID: "" } },
      (err, stdout) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout }));
  });
  assert.deepEqual(await run(home(GOOD), []), { code: 0, stdout: "1 process(es) and 1 step(s) are valid\n" });
  const bad = await run(home({ ...GOOD, "steps/bad.md": "x" }), []);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /^step bad: /m);
});

// Only an entry with wait_for (or the first entry of a run an event trigger started) gets an
// event, so {{event.*}} anywhere else always fails to render at run time.
test("{{event.*}} in a step no event reaches is reported", async () => {
  const files = {
    "steps/a.md": STEP,
    "steps/fix.md": "---\nsummary: fix\n---\nCI said {{event.data.failed}}.\n",
  };
  const proc = (steps: string, extra = "") => `description: d\ncwd: /tmp\n${extra}roles: {dev: {spawn: claude}}\nsteps:\n${steps}`;
  const bad = await checkDefs(home({ ...files, "processes/p.yaml": proc("  - {id: ci, wait_for: gh.checks, on_fail: {goto: fix}}\n  - {step: fix, role: dev, detour: true, after: {goto: ci}}\n") }));
  assert.deepEqual(bad.lines, ["process p: fix: step fix uses {{event.*}}, but only an entry with wait_for (or the first entry of a non-repeating run an on: trigger started) gets an event"]);
  const woken = await checkDefs(home({ ...files, "processes/p.yaml": proc("  - {step: fix, role: dev, wait_for: gh.checks}\n") }));
  assert.equal(woken.ok, true, woken.lines.join("\n"));
  const triggered = await checkDefs(home({ ...files, "processes/p.yaml": proc("  - {step: fix, role: dev}\n", "triggers: [{on: gh.checks}]\n") }));
  assert.equal(triggered.ok, true, triggered.lines.join("\n"));
  // a repeating run starts iteration 2 with fresh entries: the trigger's event is gone
  const repeating = await checkDefs(home({ ...files, "processes/p.yaml": proc("  - {step: fix, role: dev}\n", "repeat: true\ntriggers: [{on: gh.checks}]\n") }));
  assert.equal(repeating.ok, false);
});
