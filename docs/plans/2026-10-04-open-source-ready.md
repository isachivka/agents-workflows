# Open-source-ready flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the flows repo publishable and self-explaining: neutral examples and code, MIT licence, reference docs kept honest by a test, `CLAUDE.md` conventions (spec → plan → implementation → documentation), a `flow-author` skill and the `flow check` command it relies on.

**Architecture:** Mostly documents and file moves. One small code feature (`src/check.ts` + `flow check`), small edits to `src/install.ts`, `src/defs.ts` (exports), `src/engine.ts` (one message) and a new `test/docs.test.ts` that ties the docs to the code.

**Tech Stack:** unchanged — Node 24 TypeScript by type stripping, `node:test`, `yaml`, `croner`.

**Spec:** `docs/specs/2026-10-04-open-source-ready-design.md` — read it first. The first design, `docs/specs/2026-10-04-flows-design.md` (after Task 1 moves it), describes the system you are documenting.

## Global Constraints

- All repo text in plain English. Docs describe the code as it is; read the source before writing a fact.
- Runtime dependencies stay `yaml` and `croner`. No new dev dependency either.
- Never touch the real agterm, `~/.config/flows`, `~/.local/state/flows`, `~/.claude` or launchd from a test or a task step. Screenshots come from a throwaway flowd on a temp `FLOWS_HOME`, `FLOWS_STATE` and port 7499, with processes that spawn no agents.
- `npm test` and `npm run typecheck` green after every task; one commit per task, conventional message, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Acceptance grep (from the spec), run in Task 9: `git grep -n -i -E "user|acme|monorepo|MIG-1|acme|migration-pm|/Users/me" -- . ':!LICENSE'` prints nothing. Write new text so it already passes: "the user" / "a human", never a person's name.
- The live install links `~/.claude/skills/flow` to `skill/flow`, which Task 4 moves: that link dangles until `flow install` is re-run. Re-running it needs the human's yes (Task 9).

## Review Focus

1. A stranger follows the README from clone to the demo's last step → every command exists and works as written. (Task 6 walks it on a throwaway daemon.)
2. An agent with only the `flow-author` skill writes a process with a duplicated `clear`, a detour without `after`, and `{{event.*}}` in a detour → `flow check` names each problem in words the skill explains. (Task 3 tests, Task 4 skill.)
3. `flow check` while flowd is down or the user's plugin fails to load → it still runs and reports the plugin. (Task 3)
4. An old install's skill link to `skill/flow` → `flow install` replaces it. (Task 4)
5. A doc links a file that was renamed later → `test/docs.test.ts` fails. (Task 5)

---

### Task 1: Repo hygiene — records move, licence, package metadata

**Files:**
- Move: `docs/superpowers/specs/2026-10-04-flows-design.md` → `docs/specs/2026-10-04-flows-design.md`; `docs/superpowers/plans/2026-10-04-flows.md` → `docs/plans/2026-10-04-flows.md`
- Create: `LICENSE`
- Modify: `package.json`, `.gitignore`, the two moved files

- [ ] **Step 1: Move the records**

```bash
mkdir -p docs/specs docs/plans
git mv docs/superpowers/specs/2026-10-04-flows-design.md docs/specs/
git mv docs/superpowers/plans/2026-10-04-flows.md docs/plans/
rmdir -p docs/superpowers/specs docs/superpowers/plans 2>/dev/null; ls docs
```
Expected: `docs` holds `plans` and `specs` only.

- [ ] **Step 2: Neutralise the moved records**

Run `git grep -n -i -E "user|acme|monorepo|MIG-1|acme|migration-pm|observability|/Users/me" -- docs/specs docs/plans` and edit every hit by hand, keeping the meaning:
- a person's name → "the user" (or "the maintainer" for design approval lines);
- `monorepo` / `acme` → "a large monorepo"; `MIG-1` / typing waves → "a long JS→TS migration"; `obs-frontend`, `obs-backend` → "two observability programmes"; `/migration-pm`, `migration-pm` → "the migration's manager skill";
- the ts-wave sample in the old plan's Task 14 stays as a historical code listing, but its `cwd: ~/code/monorepo` becomes `cwd: ~/code/monorepo` and its description loses the ticket id.
Do not touch the new spec and plan (`*open-source-ready*`); they already pass.

Run the grep again. Expected: no output.

- [ ] **Step 3: Licence and package metadata**

`LICENSE` — the standard MIT text with the line `Copyright (c) 2026 Igor Sachivka` (the git author; the acceptance grep excludes this file).

`package.json` — remove `"private": true` and add, keeping the existing `bin`, `scripts`, `dependencies`, `devDependencies`:
```json
  "description": "Local agent processes built from reusable steps, run across agterm sessions, with a CLI and a web UI",
  "license": "MIT",
  "engines": { "node": ">=24" },
  "keywords": ["claude-code", "agents", "workflow", "agterm", "automation"],
```

`.gitignore` — add a line `.superpowers/`.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck && git status --short`
Expected: green; the moves show as renames.

```bash
git add -A
git commit -m "chore: move design records to docs/specs and docs/plans, MIT licence, package metadata"
```

---

### Task 2: Neutral code and the pr-loop example

**Files:**
- Modify: `src/engine.ts:260`, `test/engine-core.test.ts:130`, `test/http.test.ts:141`, `test/examples.test.ts`, `examples/steps/demo-approve.md`
- Delete: `examples/processes/ts-wave.yaml`, `examples/steps/wave-*.md`
- Create: `examples/processes/pr-loop.yaml`, `examples/steps/task-pick.md`, `task-implement.md`, `task-review.md`, `task-pr.md`, `ci-fix.md`, `task-merge.md`

- [ ] **Step 1: Make the tests ask for the new behaviour**

In `test/engine-core.test.ts:130` the expectation becomes:
```ts
  assert.equal(s.error, "c is the human's step; a human closes it");
```
In `test/examples.test.ts` the last assertion becomes:
```ts
  assert.deepEqual(Object.keys(defs.processes).sort(), ["demo", "pr-loop"]);
```
In `test/http.test.ts:141` the comment's "the user's browser" becomes "the user's browser".

Run: `npm test`
Expected: FAIL in the engine-core and examples tests.

- [ ] **Step 2: Change the engine message**

`src/engine.ts:260`:
```ts
        if (cur!.kind === "human") return fail(`${curId} is the human's step; a human closes it`);
```

- [ ] **Step 3: Replace the ts-wave sample with pr-loop**

```bash
git rm examples/processes/ts-wave.yaml examples/steps/wave-*.md
```

`examples/processes/pr-loop.yaml`:
```yaml
description: Sample — one task per iteration: a lead picks and reviews, a dev implements, CI is awaited, a human merges
cwd: ~/code/my-repo
repeat: true
max_runs: 1
roles:
  lead: {spawn: "claude --dangerously-skip-permissions"}
  dev:  {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {id: lead-fresh, do: clear, role: lead}
  - {step: task-pick, role: lead}
  - {id: dev-fresh, do: clear, role: dev}
  - {step: task-implement, role: dev}
  - {step: task-review, role: lead, on_fail: {goto: task-implement}}
  - {step: task-pr, role: lead}
  - {id: ci, wait_for: gh.checks, on_fail: {goto: ci-fix}}
  - {step: task-merge, role: human, wait_for: gh.merged}
  - {step: ci-fix, role: dev, detour: true, after: {goto: ci}}
```

`examples/steps/task-pick.md`:
```markdown
---
summary: The lead picks the next task and prepares a worktree for it
---
Pick the next task from the repo's backlog (the oldest file in docs/backlog/, or the first open
item in TODO.md). Create a fresh git worktree for it off the default branch. Then run
`flow set task=<short title> worktree=<absolute path>` and `flow done --note "<task>"`.
```

`examples/steps/task-implement.md`:
```markdown
---
summary: The dev implements the task in its worktree and commits
---
Work only in {{vars.worktree}} (use absolute paths). Implement "{{vars.task}}" test-first, run the
project's tests, and commit. If this is a second attempt, read the lead's last review notes in
`flow show` first. Then `flow done --note "<what changed, test result>"`.
```

`examples/steps/task-review.md`:
```markdown
---
summary: The lead reviews the dev's commits
---
Review the new commits in {{vars.worktree}} against "{{vars.task}}". Run the tests yourself.
Something to fix: `flow failed --note "<what to fix>"` — the task goes back to the dev.
Good: `flow done --note "<one-line verdict>"`.
```

`examples/steps/task-pr.md`:
```markdown
---
summary: The lead pushes the branch and opens the PR
---
Push the branch of {{vars.worktree}} and open a pull request for "{{vars.task}}" with `gh pr create`.
Then `flow set pr=<url>` and `flow done --evidence <url>`.
```

`examples/steps/ci-fix.md`:
```markdown
---
summary: The dev fixes red CI
---
Required CI checks failed on {{vars.pr}}. Read them with `gh pr checks {{vars.pr}}`, fix the cause
in {{vars.worktree}}, push, then `flow done`. Never skip or weaken a test to get green; if that is
the only way, `flow failed --note "<why>"`.
```

`examples/steps/task-merge.md`:
```markdown
---
summary: A human reviews and merges the PR on GitHub
---
A human reviews and merges {{vars.pr}}. The gh.merged event closes this step by itself.
```

`examples/steps/demo-approve.md` — summary `The human checks the run page and presses done`, body `The human looks at the run page and closes this step with the done button.`

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck && git grep -n -i -E "user|acme|monorepo|MIG-1|migration-pm" -- src test examples`
Expected: green; the grep prints nothing.

```bash
git add -A
git commit -m "refactor: neutral wording in code and tests; pr-loop example replaces ts-wave"
```

---

### Task 3: `flow check`

**Files:**
- Create: `src/check.ts`
- Modify: `src/cli.ts` (HELP and a `check` case), `src/defs.ts` (export `PROCESS_KEYS`, `ENTRY_KEYS` for Task 5)
- Test: `test/check.test.ts`

**Interfaces:**
- Produces: `checkDefs(home: string, name?: string, pluginDirs?: string[]): Promise<{ ok: boolean; lines: string[] }>`; default plugin dirs = repo `plugins/` then `<home>/plugins/` (what flowd loads). CLI `flow check [name]` prints `lines` on stdout and exits 0 when `ok`, else 1. It never contacts flowd.

- [ ] **Step 1: Write the failing tests**

`test/check.test.ts`:
```ts
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
```

Run: `npm test`
Expected: FAIL — cannot find `../src/check.ts`.

- [ ] **Step 2: Write `src/check.ts`**

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefs } from "./defs.ts";
import { PluginHost } from "./plugins.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Validates a FLOWS_HOME the way flowd loads it, without flowd. */
export async function checkDefs(home: string, name?: string, pluginDirs = [join(REPO, "plugins"), join(home, "plugins")]): Promise<{ ok: boolean; lines: string[] }> {
  const host = new PluginHost({ dirs: pluginDirs, config: {}, sink: () => {}, log: () => {} });
  await host.load();
  const defs = loadDefs(home, host.eventTypes(), host.actionNames());
  const lines: string[] = [];
  if (!name) for (const [plugin, err] of Object.entries(host.loadErrors)) lines.push(`plugin ${plugin}: ${err}`);
  for (const [key, errors] of Object.entries(defs.invalid)) {
    const [kind, id] = key.split(":");
    if (name && id !== name) continue;
    for (const e of errors) lines.push(`${kind} ${id}: ${e}`);
  }
  if (name && !lines.length && !defs.processes[name] && !defs.steps[name]) lines.push(`no process or step named ${name}`);
  if (lines.length) return { ok: false, lines };
  const processes = Object.keys(defs.processes).length;
  const steps = Object.keys(defs.steps).length;
  return { ok: true, lines: [name ? `${name} is valid` : `${processes} process(es) and ${steps} step(s) are valid`] };
}
```

- [ ] **Step 3: Wire it into the CLI**

In `src/cli.ts`, add to `HELP` after the `flow ls` line:
```
  flow check [name]                      validate FLOWS_HOME offline (all, or one process or step)
```
and add this case before `case "install":`:
```ts
      case "check": {
        const { checkDefs } = await import("./check.ts");
        const { flowsHome } = await import("./defs.ts");
        const r = await checkDefs(flowsHome(), a._[0]);
        for (const line of r.lines) out(line);
        return r.ok ? 0 : 1;
      }
```

In `src/defs.ts`, change `const PROCESS_KEYS` and `const ENTRY_KEYS` to `export const`.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: green.

```bash
git add src/check.ts src/cli.ts src/defs.ts test/check.test.ts
git commit -m "feat(cli): flow check validates FLOWS_HOME offline"
```

---

### Task 4: Skills — move `flow`, add `flow-author`, install both

**Files:**
- Move: `skill/flow/SKILL.md` → `skills/flow/SKILL.md`
- Create: `skills/flow-author/SKILL.md`
- Modify: `src/install.ts` (the skill link), `test/install.test.ts`, `src/cli.ts` (HELP: "skills" in the install line)

- [ ] **Step 1: Make the install test ask for both skills and the old-link replacement**

In `test/install.test.ts`, replace the line asserting `"/repo/skill/flow"` with:
```ts
  assert.equal(readlinkSync(join(home, ".claude", "skills", "flow")), "/repo/skills/flow");
  assert.equal(readlinkSync(join(home, ".claude", "skills", "flow-author")), "/repo/skills/flow-author");
```
and add at the end of the file (add `symlinkSync` to the `node:fs` import):
```ts
test("an install from before the skills/ move gets its skill link replaced", async () => {
  const home = mkdtempSync(join(tmpdir(), "flows-install-"));
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync("/repo/skill/flow", join(home, ".claude", "skills", "flow"));
  await install({ home, repo: "/repo", node: "/bin/node", launchctl: fakeBin(home, "launchctl").path, agtermctl: fakeBin(home, "agtermctl").path, uid: 501, log: () => {} });
  assert.equal(readlinkSync(join(home, ".claude", "skills", "flow")), "/repo/skills/flow");
});
```

Run: `npm test`
Expected: FAIL in the install tests.

- [ ] **Step 2: Move the role skill and change install**

```bash
mkdir -p skills && git mv skill/flow skills/flow && rmdir skill
```

In `src/install.ts`, replace
```ts
  link(join(repo, "skill", "flow"), join(home, ".claude", "skills", "flow"), say);
```
with
```ts
  for (const skill of ["flow", "flow-author"]) link(join(repo, "skills", skill), join(home, ".claude", "skills", skill), say);
```
In `src/cli.ts` HELP, the install line reads `launchd agent, agterm and Claude hooks, skills, PATH link`.

- [ ] **Step 3: Write `skills/flow-author/SKILL.md`**

````markdown
---
name: flow-author
description: Use when creating or changing flows definitions — a step, a process, a role, a trigger, a wait on an event, a plugin — or when `flow check` or the flows UI reports a process or step as invalid. Triggers on "make a flow process", "add a step to <process>", "configure flows", "new workflow", "run <process> every morning", "trigger <process> when …", "write a flows plugin", "why is <process> invalid".
---

# flow-author

flows runs processes built from steps across agterm sessions. Definitions are plain files;
flowd picks up every save by itself. This skill is the working procedure; the full reference is
[docs/processes.md](../../docs/processes.md) (every key) and [docs/plugins.md](../../docs/plugins.md).
From the installed copy of this skill, the repo is
`REPO=$(cd "$(dirname "$(readlink -f "$(command -v flow)")")/.." && pwd)` — read `$REPO/docs/processes.md`.

## Where things live

`$FLOWS_HOME` (default `~/.config/flows`): `steps/<id>.md`, `processes/<name>.yaml`,
`plugins/<name>.ts`, `plugins.yaml`. Ids and names: lowercase letters, digits, dashes.

## Procedure

1. **Look first.** `ls $FLOWS_HOME/steps $FLOWS_HOME/processes`; read the process you are changing.
   Reuse a step whose prompt already fits.
2. **Write the steps.** Frontmatter `summary:` (one line, shown in the UI), then the prompt. Talk
   to the agent directly, say what "done" means, and end with how to report:
   `flow done --note "…"`, or `flow failed --note "…"`. A value a later step needs: tell the agent
   to `flow set key=value`, and read it later as `{{vars.key}}`.
3. **Write the process.** `description`, `cwd`, `roles` (each a `spawn` command — it runs in a login
   shell without your aliases, so write `--dangerously-skip-permissions` yourself if you want it),
   then `steps` in order.
4. **Check.** `flow check <name>` and fix every line it prints; then `flow check` with no name.
5. **Try it.** `flow start <name>` and watch http://127.0.0.1:7420. Ask the user first if the run
   would spawn agents that change real code.

## Choosing an entry

| You want | Write |
|---|---|
| an agent does work | `{step: <id>, role: <role>}` |
| the user does or approves something | `{step: <id>, role: human}` (closed from the UI or `flow done --human`) |
| a fresh context before a step | `{do: clear, role: <role>}`; `compact` keeps a summary |
| wait for CI, a merge, a signal | `{wait_for: gh.checks}` alone — the event's outcome closes it |
| an agent reacts to an event | `{step: <id>, role: <role>, wait_for: gh.checks}`; the prompt reads `{{event.outcome}}`, `{{event.data.<key>}}` |
| retry, or loop back on failure | `on_fail: retry` or `on_fail: {goto: <id>}`; `retries` caps failures per iteration (default 3) |
| a fix-up branch | `{step: <id>, role: <role>, detour: true, after: {goto: <id>}}` after the main line; reached only by a `goto` |
| start on a schedule or an event | `triggers: [{cron: "0 10 * * 1-5"}]`, `[{on: flow.run.done, where: {process: other}}]` |
| one item per pass, forever | `repeat: true` — vars are cleared between iterations |

## Traps

- Two entries with the same `step` or `do` need explicit ids: `{id: clear-lead, do: clear, role: lead}`.
- `{{event.*}}` exists only in an entry an event woke: one with its own `wait_for`, or the first
  entry of a run an event trigger started. A detour reached by `goto` has no event — have the
  agent read the state (`gh pr checks {{vars.pr}}`) instead.
- A missing `{{vars.x}}` stops the run for the user rather than sending a broken prompt: an earlier
  step of the same iteration must `flow set` it.
- Ad-hoc events need the `signal.` prefix in definitions (`wait_for: signal.deploy-done`);
  `flow signal deploy-done` adds it when sending.
- A plugin's event types are `<plugin>.<event>`; an unknown type fails `flow check`.
- `human` is a reserved role; agent roles must be declared under `roles`.
- `gh.*` waits need the PR: `flow set pr=<url>` before the wait, or
  `wait_for: {on: gh.checks, with: {pr: "{{vars.pr}}"}}`.
- Edits reach running runs at their next step. Removing the entry a run stands on stops that run
  for the user.

## New event sources and actions

Write a plugin, not daemon code: a TS file in `$FLOWS_HOME/plugins/` whose default export is
`{name, events, start?, watch?, actions?}`, configured in `plugins.yaml` — see
[docs/plugins.md](../../docs/plugins.md). flowd loads plugins at start: ask the user before
restarting it (UI → Plugins → Restart, or `launchctl kickstart -k gui/$UID/local.flows`).
````

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: green.

```bash
git add -A
git commit -m "feat(skills): skills/ with flow and the new flow-author; install links both"
```

---

### Task 5: Reference docs and the docs test

**Files:**
- Create: `docs/concepts.md`, `docs/processes.md`, `docs/plugins.md`, `docs/cli.md`, `docs/http-api.md`, `docs/architecture.md`, `docs/troubleshooting.md`
- Test: `test/docs.test.ts`

Write each doc from the code, not from memory: open the module named next to each fact. Prefer tables for reference material and one short example per concept. No marketing words.

- [ ] **Step 1: Write the failing docs test**

`test/docs.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_EVENTS, ENTRY_KEYS, PROCESS_KEYS } from "../src/defs.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Living docs only: specs and plans are records and may name files that later moved. */
function markdownFiles(): string[] {
  const top = ["README.md", "CONTRIBUTING.md", "CLAUDE.md"].filter((f) => existsSync(join(ROOT, f)));
  const docs = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  const skills = readdirSync(join(ROOT, "skills")).map((d) => `skills/${d}/SKILL.md`).filter((f) => existsSync(join(ROOT, f)));
  return [...top, ...docs, ...skills];
}

test("relative links in the living docs resolve", () => {
  const broken: string[] = [];
  for (const file of markdownFiles()) {
    const text = read(file).replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (!existsSync(join(ROOT, dirname(file), decodeURIComponent(target)))) broken.push(`${file} -> ${m[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("docs/processes.md documents every key the loader accepts", () => {
  const doc = read("docs/processes.md");
  const keys = [...PROCESS_KEYS, ...ENTRY_KEYS, "summary", "spawn", "cwd", "cron", "on", "where", "with"];
  assert.deepEqual(keys.filter((k) => !doc.includes(`\`${k}\``)), []);
});

test("docs/cli.md documents every flow command", () => {
  const cmds = [...read("src/cli.ts").matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => m[1]).filter((c) => c !== "help");
  const missing = [...new Set([...cmds, "agterm-hook", "claude-hook"])].filter((c) => !read("docs/cli.md").includes(`flow ${c}`));
  assert.deepEqual(missing, []);
});

test("docs/concepts.md lists every core event", () => {
  const doc = read("docs/concepts.md");
  assert.deepEqual(CORE_EVENTS.filter((e) => !doc.includes(e)), []);
});

test("every skill names itself and says when to use it", () => {
  for (const dir of readdirSync(join(ROOT, "skills"))) {
    const text = read(`skills/${dir}/SKILL.md`);
    assert.match(text, new RegExp(`^---\\n(?:.*\\n)*?name: ${dir}\\n(?:.*\\n)*?---`), dir);
    assert.match(text, /\ndescription: .{40,}\n/, dir);
  }
});
```

Run: `npm test`
Expected: FAIL — `docs/processes.md`, `docs/cli.md`, `docs/concepts.md` missing, and the skill's links to `docs/*.md` do not resolve.

- [ ] **Step 2: Write `docs/concepts.md`**

Sections and the facts each must state (sources in brackets):
1. **The pieces** — step, process, role, run, entry, event, plugin, flowd, `flow`; one sentence each.
2. **A run's life** — run statuses `running`, `paused`, `needs-human`, `done`, `stopped` and what moves between them; entry statuses `pending`, `waiting`, `active`, `done`, `failed`, `skipped` [src/types.ts, src/engine.ts]. A small ASCII state diagram is welcome.
3. **Delivery to agents** — the one-line nudge `▶ flow: step <id> · <run> it.<n> — run \`flow show\` for the instructions`; why not the whole prompt; never typed into an `active` session; text then Enter through `--stdin` with a 500 ms pause; 2 s gap between lines; 15 s grace after a spawn; a nudge whose step moved on is dropped; an agent can close a step only after its nudge was typed (`step X has not reached the agent yet`) [src/daemon.ts, src/agterm.ts, src/engine.ts].
4. **Sessions and roles** — lazy spawn as `/bin/zsh -lc '<spawn> <first line>'` in workspace `<process>`, session name `<run> <role>`; binding at start; one session per open run; a closed session unbinds its role and stops the run only if that role was mid-step; respawn and rebind [src/daemon.ts, src/engine.ts].
5. **Reminders and timeouts** — 30 s after a turn ends without a report, at most 2 reminders, then `needs-human`; `blocked` is not the end of a turn; entry `timeout`; `compact` times out after 10 min [src/engine.ts].
6. **clear and compact** — `/clear` is done at once; `/compact` is done when Claude's `PostCompact` hook reports (`flow claude-hook compacted`); both are no-ops on a role without a session [src/engine.ts, src/install.ts].
7. **Events** — targeted vs broadcast; `where` matching; `signal.*`; the core events `flow.step.done`, `flow.step.failed`, `flow.iteration.done`, `flow.run.done`, `flow.run.needs-human`, `flow.trigger.skipped` with their data (`process`, `run`, `entry`, …) [src/defs.ts CORE_EVENTS, src/engine.ts emit].
8. **Triggers** — cron, `on` + `where`, `max_runs`, what a refused trigger records [src/daemon.ts startRun].

- [ ] **Step 3: Write `docs/processes.md`**

1. **Files** — `$FLOWS_HOME` layout, `FLOWS_HOME` env, name rule `^[a-z0-9][a-z0-9-]*$` [src/defs.ts NAME_RE].
2. **Step files** — frontmatter `summary` (required, only key), the body; placeholders `{{run.id}}`, `{{run.process}}`, `{{run.iteration}}`, `{{vars.<key>}}`, `{{event.type}}`, `{{event.outcome}}`, `{{event.data.<key>}}`; objects render as JSON; a missing value stops the run (`needs-human`) [src/template.ts, src/engine.ts renderData].
3. **Process keys** — a table: `description` (required), `cwd` (required, `~` allowed), `repeat` (false), `max_runs` (1), `triggers`, `roles`, `steps` (required, non-empty); each with type, default, meaning [src/defs.ts parseProcess].
4. **Roles** — `spawn` (required), `cwd` (template, defaults to the process `cwd`); `human` reserved; the login shell and aliases note.
5. **Triggers** — `cron` (croner syntax, 5 fields), `on` + `where`.
6. **Entries** — a table of kinds (agent step, human step, `do: clear|compact|type`, `do: <plugin>.<action>`, pure wait) and a table of every key: `id`, `step`, `role`, `do`, `text`, `with`, `wait_for` (string, or `on`/`where`/`with`), `on_fail` (`human` default, `retry`, `{goto}`), `retries` (3), `after`, `detour`, `timeout` (`30s`, `10m`, `2h`, `1d`) — type, default, meaning [src/defs.ts ENTRY_KEYS].
7. **How a run moves** — advancing skips detours; `goto` resets the target through the failed entry (forward goto: the target only), keeping attempt and failure counts; `retries` counted per iteration; iteration end; `repeat` clears vars [src/engine.ts].
8. **Validation** — every rule `flow check` enforces, phrased as the message the user will see [src/defs.ts].
9. **Editing live** — edits apply from a run's next entry; removed current entry → `needs-human`; the UI's form rewrites YAML (comments lost), its YAML tab keeps text.
10. **Recipes** — copy-paste YAML for: CI loop with a fix-up detour; review loop with `on_fail: {goto}`; a morning cron; chaining processes with `on: flow.run.done`; a human gate. Run each through `flow check` on a temp home before pasting it into the doc.

- [ ] **Step 4: Write `docs/plugins.md`**

1. **When to write one** — a new event source or action; never daemon code.
2. **The interface** — `name`, `events`, `start(ctx)`, `watch(w, ctx)` returning a stop function, `actions`; the `Watch` and `PluginCtx` fields; `ctx.emit` prefixes the type and sets `source`; targeted (`run`/`entry`) vs broadcast; `outcome` [src/plugins.ts].
3. **Lifecycle** — loading order (repo `plugins/`, then `$FLOWS_HOME/plugins/`, same name wins later), reserved names `flow` and `signal`, `start` once at boot, `watch` only while an entry waits, retries with backoff (5 s doubling, 5 min cap), errors on the Plugins page, restart needed after a change [src/plugins.ts, src/daemon.ts].
4. **Configuration** — `plugins.yaml`, one mapping per plugin name, reaches the plugin as `ctx.config` [src/daemon.ts readPluginConfig].
5. **Worked example: gh** — events, what `gh` command each polls, how the outcome is decided, zero checks counted as pending for 5 polls, `interval_ms`, emits once per watch [plugins/gh.ts].
6. **A minimal plugin** — a complete small file (e.g. `timer`: `watch` emits `timer.elapsed` after `with.seconds`) and the process entry that uses it. Verify it: drop it into a temp `FLOWS_HOME/plugins/` and run `flow check`.
7. **Testing a plugin** — inject the I/O as `test/gh.test.ts` does.
8. **Sketch: Slack** — `start` holds Socket Mode and emits `slack.dm`/`slack.mention`; `actions.post` replies in a thread. Mark it as a sketch.

- [ ] **Step 5: Write `docs/cli.md`**

Every command with synopsis, options, what it prints, exit code, one example: `flow show`, `flow done`, `flow failed`, `flow set`, `flow signal`, `flow start`, `flow ls`, `flow check`, `flow install` (exactly what it changes, and that it replaces its own old hooks and links), `flow daemon`, `flow help`, and the hook entry points `flow agterm-hook`, `flow claude-hook` (not for hand use). Then the environment: `FLOWD_URL`, `FLOWD_PORT`, `FLOWS_HOME`, `FLOWS_STATE`, `FLOWS_AGTERMCTL`, `FLOWS_LAUNCHCTL`, `AGTERM_SESSION_ID` [src/cli.ts, src/install.ts, src/main.ts]. Refusals print `flow: <reason>` and exit 1.

- [ ] **Step 6: Write `docs/http-api.md`**

Every route in `src/http.ts` as a table (method, path, body/query, response), path ids URI-encoded (`ts-wave%233`), the error shapes (`{error}` 409/404/400, `{errors}` 409/422, 403 foreign Host/Origin, 415 non-JSON body), `GET /api/stream` (SSE, `data: runs|defs`), and the two hook endpoints. Check the table against `src/http.ts` line by line.

- [ ] **Step 7: Write `docs/architecture.md`**

1. A box diagram: agterm sessions ↔ `flowd` (engine, store, plugins, cron, HTTP+UI) ↔ `flow` CLI / browser / agterm hooks / Claude hook.
2. Modules — one line each for every file in `src/`, `plugins/`, `ui/`.
3. An event's path — `submit` → stored → processed one at a time → `handle`/`route` → `engine.step` → one transaction (state, outbox, emitted events) → watch/unwatch/plugin actions → `flush` → `agterm.type` → `entry.delivered`.
4. Storage — the four tables and what survives a restart; restart recovery (re-arm watches, deliver queued lines, sessions missing from agterm treated as closed).
5. Security model — localhost only; Host/Origin checks against DNS rebinding and cross-site POSTs; JSON-only bodies; spawned agents usually run with `--dangerously-skip-permissions`, so anything that can reach flowd can run code.
6. Design records — links to `specs/2026-10-04-flows-design.md` and `specs/2026-10-04-open-source-ready-design.md`.

- [ ] **Step 8: Write `docs/troubleshooting.md`**

Symptom → check → fix, for: flowd not running (`launchctl print gui/$UID/local.flows`, the log path, `kickstart -k`); port 7420 busy; an agent never got its line (`flow ls`, session `active`?, run `paused`?); a line typed but not submitted (known gap — link `backlog/` item from Task 8 by its file name `silent-submit-stuck-step.md`); compact never finishes (PostCompact hook in `~/.claude/settings.json`); agterm hooks not firing (`agtermctl hooks list`); node upgraded under nvm (re-run `flow install`); a process shows as invalid (`flow check`); starting over (stop the agent, move `~/.local/state/flows/flows.db` aside).

Task 8 creates the backlog file this doc links to. Until then that link fails the docs test: either do Task 8's `silent-submit-stuck-step.md` now, or write the link in Task 8. Do the former — create that one backlog file here with the content given in Task 8.

- [ ] **Step 9: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: green, including all five docs tests.

```bash
git add docs test/docs.test.ts
git commit -m "docs: concepts, process and plugin reference, CLI, HTTP API, architecture, troubleshooting"
```

---

### Task 6: README, screenshots, CONTRIBUTING

**Files:**
- Rewrite: `README.md`
- Create: `CONTRIBUTING.md`, `docs/assets/ui-runs.png`, `docs/assets/ui-run.png`, `docs/assets/ui-process.png`

- [ ] **Step 1: Take the screenshots on a throwaway daemon**

```bash
H=$(mktemp -d)/home; mkdir -p "$H/processes" "$H/steps"
cp examples/processes/pr-loop.yaml "$H/processes/"; cp examples/steps/*.md "$H/steps/"
printf 'description: Release checklist — the human confirms each gate\ncwd: /tmp\nsteps:\n  - {step: demo-approve, role: human}\n  - {id: wait-deploy, wait_for: signal.deployed}\n  - {id: confirm, step: demo-approve, role: human}\n' > "$H/processes/release.yaml"
FLOWS_HOME="$H" FLOWS_STATE="$H/state.db" FLOWD_PORT=7499 node src/cli.ts daemon & FLOWD=$!
sleep 1
FLOWD_URL=http://127.0.0.1:7499 node src/cli.ts start release
FLOWD_URL=http://127.0.0.1:7499 node src/cli.ts done --human --run release#1 --step demo-approve
```
No agent role is involved, so nothing spawns. With the agent-browser skill, at 1280×800, light mode:
`http://127.0.0.1:7499/#/runs` → `docs/assets/ui-runs.png`; `#/run/release%231` → `docs/assets/ui-run.png`; `#/process/pr-loop` → `docs/assets/ui-process.png`. Look at each image before keeping it. Then `kill $FLOWD`.

- [ ] **Step 2: Write `README.md`**

Sections, in order, each short:
1. `# flows` and one sentence: local agent processes built from reusable steps, run across agterm sessions, with a CLI and a web UI.
2. `![Runs](docs/assets/ui-runs.png)`.
3. **Why** — 3–5 sentences: long agent work is a loop of fresh contexts and handoffs between sessions; outside events (CI, a merge, a message) should wake it; it should run on your machine, in terminals you can watch and take over.
4. **What you get** — bullets: steps as Markdown prompts; processes as YAML (roles, order, retries, goto, detours, waits, repeat, cron/event triggers); flowd types each step into the right agterm session, clears or compacts between steps, reminds a silent agent; a web UI to watch, edit and override, with a jump to the agent's terminal; plugins for event sources (`gh` built in).
5. **Requirements** — macOS; agterm with `agtermctl` on PATH; Node.js ≥ 24; Claude Code; `gh` for the gh plugin.
6. **Install** — clone, `npm install`, `bin/flow install` and the list of what it changes (launchd agent `local.flows`; two lines in `~/.config/agterm/hooks.conf`; a `PostCompact` hook in `~/.claude/settings.json` with a backup; skills `flow` and `flow-author` in `~/.claude/skills`; `~/.local/bin/flow`), `mkdir -p ~/.config/flows && cp -Rn examples/* ~/.config/flows/`, open http://127.0.0.1:7420.
7. **Quickstart: the demo** — `flow start demo`; what to watch (a `demo` workspace appears, the agent says hello and sets a variable, `/compact`, `/clear`, it waits); `flow signal demo msg=hi`; press `done` on the last step in the UI. Walk it on the throwaway daemon as far as it goes without agents (the commands must exist and the UI pages must match the text).
8. **A process at a glance** — the `pr-loop.yaml` listing and two sentences on reading it; `![Process editor](docs/assets/ui-process.png)`.
9. **Agents** — the `▶ flow:` line, `flow show` / `flow done` / `flow failed` / `flow set`; the two skills.
10. **Documentation** — a table linking every `docs/*.md` with one line each.
11. **Status** — alpha; known gaps in [docs/backlog/](docs/backlog/).
12. **Contributing** — link CONTRIBUTING.md and CLAUDE.md. **License** — MIT.

- [ ] **Step 3: Write `CONTRIBUTING.md`**

```markdown
# Contributing

Changes to flows go through four stages — spec, plan, implementation, documentation — described in
[CLAUDE.md](CLAUDE.md). The same rules apply to people and to agents.

## Setup

Requirements: macOS, Node.js ≥ 24, agterm, Claude Code.

    npm install
    npm test
    npm run typecheck

Run a daemon that does not touch your real setup:

    FLOWS_HOME=$(mktemp -d) FLOWS_STATE=$(mktemp -d)/flows.db FLOWD_PORT=7499 bin/flow daemon

Tests never touch the real agterm, `~/.config/flows`, `~/.claude` or launchd; keep it that way.

## Where things go

| What | Where |
|---|---|
| A design (approved before work starts) | `docs/specs/YYYY-MM-DD-<topic>-design.md` |
| An implementation plan | `docs/plans/YYYY-MM-DD-<topic>.md` |
| Deferred work | `docs/backlog/<slug>.md`, one item per file |
| User and reference docs | `README.md`, `docs/*.md` |
| Agent skills | `skills/<name>/SKILL.md` |

## Pull requests

One topic per PR. Tests and typecheck green. Docs updated for whatever the change makes untrue.
Link the spec and plan when there are any. Conventional commit messages.
```

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: green (the link test now covers README and CONTRIBUTING).

```bash
git add README.md CONTRIBUTING.md docs/assets
git commit -m "docs: README with quickstart and screenshots, CONTRIBUTING"
```

---

### Task 7: CLAUDE.md and AGENTS.md

**Files:**
- Create: `CLAUDE.md`, `AGENTS.md` (symlink to `CLAUDE.md`)

- [ ] **Step 1: Write `CLAUDE.md`**

Fill the module table from the real tree (`ls src plugins ui test`), one line per file.

````markdown
# flows — conventions for agents working in this repo

flows is a local daemon (`flowd`) that runs agent processes built from reusable steps across
agterm sessions, with a CLI (`flow`) and a web UI. Read [README.md](README.md) and
[docs/architecture.md](docs/architecture.md) before changing code.

## How work is done: spec → plan → implementation → documentation

Every change that adds or changes behaviour goes through four stages, each leaving an artifact:

1. **Spec** — `docs/specs/YYYY-MM-DD-<topic>-design.md`: problem, goals, non-goals, decisions,
   testing. A human approves it before any code. (With superpowers: `brainstorming`.)
2. **Plan** — `docs/plans/YYYY-MM-DD-<topic>.md`: small tasks, each with its files, the failing
   test, the code, the commands and their expected output. A human reviews it.
   (With superpowers: `writing-plans`.)
3. **Implementation** — task by task, test first, one commit per task, `npm test` and
   `npm run typecheck` green after each. A deviation from the plan is explained in its commit.
4. **Documentation** — update everything the change made untrue or incomplete: `docs/*.md`,
   `README.md`, `skills/*/SKILL.md`, `examples/`, the CLI help. The change is not done while any
   of them describes the old behaviour. `test/docs.test.ts` catches some drift, not all.

A small fix (an obvious bug, a typo) skips the spec and the plan, never the test or the docs.
Specs and plans are records: never rewrite an old one to match new code — write a new one.

## Map

| Path | What |
|---|---|
| `src/…` | one row per module: what it owns |
| `plugins/gh.ts` | built-in GitHub plugin |
| `ui/` | web UI, Preact + htm vendored, no build |
| `skills/flow`, `skills/flow-author` | skills for agents running steps / authoring definitions |
| `examples/` | a sample `$FLOWS_HOME` |
| `docs/` | reference docs; `specs/`, `plans/` records; `backlog/` deferred work |
| `test/` | `node:test` suites; `daemon-helpers.ts`, `http-helpers.ts` hold the fakes |

## Code

- Node 24 runs the TypeScript directly: erasable syntax only (no `enum`, `namespace`, constructor
  parameter properties), relative imports end in `.ts`, type-only imports use `import type`.
- Runtime dependencies are `yaml` and `croner`. Adding any dependency needs a human's yes.
- `src/engine.ts` stays pure: no I/O, time comes in as `ctx.now`; it returns actions and
  `src/daemon.ts` carries them out.
- Every `agtermctl` call goes through `src/agterm.ts`; every database access through `src/store.ts`.
- A new event source or action is a plugin, not daemon code.
- A refusal tells the reader what is wrong and what to do about it.

## Tests

- `node:test` and `node:assert/strict`, files `test/*.test.ts`. New behaviour gets a test that
  fails first.
- Temp directories and fakes only. A test never touches the real agterm, `~/.config/flows`,
  `~/.local/state/flows`, `~/.claude` or launchd.
- Tests that run the CLI set `AGTERM_SESSION_ID` explicitly; the runner may itself be inside an
  agterm session.

## Ask a human first

- `flow install` (it changes launchd, `~/.config/agterm/hooks.conf`, `~/.claude/settings.json`),
  restarting `local.flows`, or starting runs that spawn agents in the real agterm.
- Adding a dependency, or loosening the HTTP Host/Origin/content-type checks.

## Deferred work

A real problem you are not fixing now goes to `docs/backlog/<slug>.md`: frontmatter
`worth: high|medium|low`, `where: <file or area>`, `added: YYYY-MM-DD`, then what happens, why it
matters, and the fix if known. Fixing it deletes the file in the same commit.

## Writing

Docs, comments and commit messages in plain English. Conventional commits (`feat(engine): …`,
`fix(http): …`, `docs: …`). Comments say why, not what.
````

Replace the `src/…` row with one row per real file before committing.

- [ ] **Step 2: Link AGENTS.md and verify**

```bash
ln -s CLAUDE.md AGENTS.md
npm test && npm run typecheck
```
Expected: green; `readlink AGENTS.md` prints `CLAUDE.md`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: CLAUDE.md conventions — spec, plan, implementation, documentation"
```

---

### Task 8: Backlog of deferred findings

**Files:**
- Create: `docs/backlog/<slug>.md` for each item below (`silent-submit-stuck-step.md` already exists from Task 5)

Each file:
```markdown
---
worth: <high|medium|low>
where: <file or area>
added: 2026-10-04
---
<What happens, in one or two sentences.> <Why it matters.> <The fix, if known.>
```

Verify each item against the code before writing it; drop one the code already handles and say so in the commit message.

| slug | worth | where | what |
|---|---|---|---|
| `silent-submit-stuck-step` | high | `src/daemon.ts` flush, `src/engine.ts` reminders | A typed line that never submits leaves its entry `active` forever: reminders start only after the session went `active`, which never happens. Fix: after a delivery, expect `active` within N seconds; otherwise re-send Enter once, then halt. |
| `typing-fixed-pause` | medium | `src/agterm.ts` | Text and Enter are 500 ms apart; a slower TUI can miss the Enter. Fix: read the screen back (`session text`) and retry, as peer-chat does. |
| `type-clear-goto-loop` | medium | `src/engine.ts` | A `goto` loop made only of `type`/`clear` entries recurses until a stack overflow and leaves the run stuck; the no-work guard covers iteration ends only. |
| `commit-and-processed-split` | medium | `src/daemon.ts` | Saving the run state and marking the event processed are separate transactions; a crash between them can start a run twice. |
| `agtermctl-retry-no-backoff` | medium | `src/daemon.ts` flush/spawnFor | Retries run every flush tick without backoff; a spawn that timed out but succeeded can be retried into a second session. |
| `gh-watch-stale-pr` | medium | `plugins/gh.ts`, `src/daemon.ts` | A watch gets the vars at arm time; a `flow set pr=…` made after the wait started is not seen. |
| `install-settings-order` | medium | `src/install.ts` | `settings.json` is written in place and parsed only after launchd and hooks.conf were changed; a malformed file aborts the install halfway. Fix: parse first, write atomically. |
| `launchctl-bootstrap-race` | low | `src/install.ts` | `bootstrap` right after `bootout` can fail on re-install; the error is only printed. |
| `session-status-events-grow` | low | `src/store.ts` | Every agterm status from every session is stored as an event forever. |
| `startup-closed-events-order` | low | `src/daemon.ts` reconcileSessions | Closed-session events from the startup check are processed before older unprocessed events. |
| `human-report-without-target` | low | `src/cli.ts`, `src/daemon.ts` | `flow done --human` without `--run/--step` resolves through the session and skips the guard against closing a step twice. |
| `session-bound-to-two-roles` | low | `src/daemon.ts` startRun | One session can be bound to two roles of the same run. |
| `double-nudge-or-close` | low | `src/daemon.ts`, `ui/app.js` | Rare retries or a double click can send a nudge twice or close a step twice. |
| `runs-status-filter` | low | `src/http.ts` | The spec's `GET /api/runs?status=` is not implemented (`?all=1` is). |
| `malformed-percent-500` | low | `src/http.ts` | A malformed `%` in a path returns 500 instead of 400. |
| `quote-in-entry-id` | low | `src/defs.ts` | Entry ids are not validated; an id with a quote reaches the spawn command line. |

- [ ] **Step 1: Write the files**, then run `ls docs/backlog | wc -l` (expected: 16, fewer if you dropped any) and `npm test`.

- [ ] **Step 2: Commit**

```bash
git add docs/backlog
git commit -m "docs: backlog of findings deferred from the first implementation"
```

---

### Task 9: Final check and handover

- [ ] **Step 1: Full verification**

```bash
npm test && npm run typecheck
git grep -n -i -E "user|acme|monorepo|MIG-1|acme|migration-pm|/Users/me" -- . ':!LICENSE'
git status --short
```
Expected: green; the grep prints nothing; the tree is clean.

- [ ] **Step 2: Read the repo as a stranger**

Read README → docs/concepts.md → docs/processes.md → skills/flow-author/SKILL.md in that order. Fix anything that contradicts the code or another doc, anything that assumes knowledge not given earlier, and any step a reader could not follow. Commit fixes as `docs: …`.

- [ ] **Step 3: Hand over**

The skill directory moved, so the live `~/.claude/skills/flow` link dangles and `flow-author` is not installed. Ask the human to approve re-running `bin/flow install`; with a yes, run it and confirm `readlink ~/.claude/skills/flow ~/.claude/skills/flow-author` and `curl -s http://127.0.0.1:7420/api/plugins`. Report: commits, test count, grep result, what was dropped from the backlog list and why, and every deviation from this plan.
