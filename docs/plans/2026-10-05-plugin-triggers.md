# Plugin Events as Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a plugin event start a process: a trigger becomes a standing subscription delivered through the same `watch()` as a wait, and the `gh` plugin gains a repo mode with `gh.merged`, the new `gh.opened` and the new `gh.ci`.

**Architecture:** `Watch.run`/`entry` become optional; a run-less watch is a trigger subscription, keyed by `(type, cwd, with)` and shared by every process that asks for it. flowd syncs subscriptions on every definitions load. A plugin emits run-less events as broadcasts, which routing already matches against triggers. A run started by an event gets the event's scalar data as vars.

**Tech Stack:** unchanged (Node 24 TypeScript, `node:test`, `yaml`, `croner`).

**Spec:** `docs/specs/2026-10-05-plugin-triggers-design.md`. Follow `CLAUDE.md` (spec → plan → implementation → documentation).

## Global Constraints

- The code moved on after the earlier plans (latest: `e4cfa71`, reload keeps unchanged watches). Before each task, read the current file and fit the change to it; the snippets below show the logic, not exact line numbers.
- No new dependency. Tests use fakes only (`FakeAgterm`, fake `exec` for `gh`, the test plugin in `test/daemon-helpers.ts`). Never call the real `gh`, agterm or launchd from a test.
- `npm test` and `npm run typecheck` green after every task; one commit per task, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Existing waits must behave exactly as before (the 116+ existing tests stay green unchanged, except where this plan says otherwise).

## Review Focus

1. Two processes trigger on the same `gh.merged` subscription → one plugin watch, one event, both processes start. (Task 4)
2. Editing an unrelated part of a process (or another process) → an existing subscription is not recreated, so gh's baseline survives and history never fires. (Task 4)
3. A subscription whose plugin throws (`gh.checks` as a trigger) → the error shows in `/api/plugins` and in the process's `triggerErrors`, and retries with backoff; nothing else breaks. (Tasks 4, 6)
4. gh repo mode's first poll after a restart → baseline only, no burst of old merges. (Task 5)
5. A wait in repo mode (`wait_for: {on: gh.ci, with: {branch: main}}`) → emits once to that step and stops. (Task 5)

---

### Task 1: Plugin host — run-less watches are subscriptions

**Files:** Modify `src/plugins.ts`; Test `test/plugins.test.ts`

**Interfaces (produced):**
- `interface Watch { type: string; with: Dict; cwd: string; run?: string; entry?: string; vars: Record<string, string>; processes?: string[] }`
- `subscriptionKey(w: Pick<Watch, "type" | "cwd" | "with">): string` — `trigger\0<type>\0<cwd>\0<stable JSON of with>` (keys sorted at every level)
- `PluginHost.watch(w)` keys a wait by `run\0entry` (as today) and a run-less watch by `subscriptionKey(w)`
- `PluginHost.unsubscribe(key: string)`, `PluginHost.subscription(key: string): Watch | undefined`, `PluginHost.subscriptionKeys(): string[]`
- `PluginStatus.watches[]` items become `{ run: string | null; entry: string | null; type: string; processes: string[] | null; error: string | null }`

- [ ] **Step 1: Failing tests** — add to `test/plugins.test.ts` (`w()` there builds a wait; give it `cwd: "/repo"`):

```ts
const sub = (type: string, withArgs = {}): Watch => ({ type, with: withArgs, cwd: "/repo", vars: {}, processes: ["p"] });

test("a run-less watch is a subscription keyed by type, cwd and with", () => {
  const { h } = host();
  const log: string[] = [];
  h.add({ name: "demo", watch: (x) => { log.push(`watch ${x.run ?? "sub"}`); return () => log.push("stop"); } });
  h.watch(sub("demo.ping", { b: 1, a: 2 }));
  const k = subscriptionKey(sub("demo.ping", { a: 2, b: 1 }));
  assert.deepEqual(h.subscriptionKeys(), [k]);
  assert.equal(h.subscription(k)?.type, "demo.ping");
  h.unsubscribe(k);
  assert.deepEqual(h.subscriptionKeys(), []);
  assert.deepEqual(log, ["watch sub", "stop"]);
});

test("a subscription's emit without run is a broadcast; status shows who asked", () => {
  const { h, sunk } = host();
  h.add({ name: "demo", watch: (_x, ctx) => { ctx.emit({ type: "ping", data: { a: 1 } }); } });
  h.watch(sub("demo.ping"));
  assert.deepEqual(sunk, [{ type: "demo.ping", data: { a: 1 }, outcome: undefined, run: undefined, entry: undefined, source: "demo" }]);
  assert.deepEqual(h.status()[0].watches, [{ run: null, entry: null, type: "demo.ping", processes: ["p"], error: null }]);
});

test("a throwing subscription is reported and retried like a wait", async () => {
  const { h } = host();
  let calls = 0;
  h.add({ name: "demo", watch: () => { if (++calls === 1) throw new Error("needs with.repo"); } });
  h.watch(sub("demo.ping"));
  assert.equal(h.status()[0].watches[0].error, "needs with.repo");
  await sleep(40);
  assert.equal(calls, 2);
});
```
Run `npm test` → FAIL (`subscriptionKey` not exported, `cwd` missing on `Watch`).

- [ ] **Step 2: Implement.** Change `Watch` as above. Store the map key on `Active` (`key: string`) so `arm`'s retry and `stopAll` use it; `watch(w)` computes `w.run ? key(w.run, w.entry!) : subscriptionKey(w)`; `unwatch(run, entry)` and `unsubscribe(k)` share one private `drop(k)`. `status()` maps `run`/`entry`/`processes` to `null` when absent. Fix every existing caller of `Watch` the compiler flags (the daemon passes `cwd` — Task 4 makes it correct; here pass `expandHome(this.defs.processes[run.process]?.cwd ?? "~")` from `src/agterm.ts`). Update the existing test helper `w()` to include `cwd`.

```ts
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
export const subscriptionKey = (w: Pick<Watch, "type" | "cwd" | "with">) => `trigger\u0000${w.type}\u0000${w.cwd}\u0000${stable(w.with)}`;
```

- [ ] **Step 3:** `npm test && npm run typecheck` → green. Commit `feat(plugins): run-less watches are trigger subscriptions`.

---

### Task 2: Triggers take `with`

**Files:** Modify `src/types.ts` (`Trigger` gains `with: Dict`), `src/defs.ts`; Test `test/defs.test.ts`

- [ ] **Step 1: Failing test:**

```ts
test("an on: trigger takes a with mapping; cron does not", () => {
  const p = parseProcess("t", `description: d\ncwd: /tmp\ntriggers:\n  - {on: gh.merged, with: {base: main}, where: {author: me}}\nsteps:\n  - {wait_for: signal.x}\n`, ctx);
  assert.deepEqual(p.triggers[0], { on: "gh.merged", where: { author: "me" }, with: { base: "main" } });
  const errs = errorsOf(() => parseProcess("t", `description: d\ncwd: /tmp\ntriggers:\n  - {on: gh.merged, with: main}\n  - {cron: "0 10 * * *", with: {a: 1}}\nsteps:\n  - {wait_for: signal.x}\n`, ctx));
  assert.ok(errs.includes("trigger 1: with must be a mapping"), errs.join(" | "));
  assert.ok(errs.includes("trigger 2: with only applies to on: triggers"), errs.join(" | "));
});
```
Existing assertions on `p.triggers` gain `with: {}`.

- [ ] **Step 2:** In `parseProcess`, the `on` branch pushes `{ on, where, with: isObj(t.with) ? t.with : {} }` and errors `with must be a mapping` when `t.with` is present and not a mapping; the `cron` branch pushes `with: {}` and errors `with only applies to on: triggers` when `t.with` is present.

- [ ] **Step 3:** green; commit `feat(defs): on: triggers take with`.

---

### Task 3: A triggered run gets the event data as vars

**Files:** Modify `src/engine.ts` (`case "start"`); Test `test/engine-core.test.ts`

- [ ] **Step 1: Failing test:**

```ts
test("a run started by an event gets the event's scalar data and type as vars", () => {
  const s = new Sim(LINEAR, STEPS).send({ kind: "start", event: { type: "gh.merged", data: { pr: "https://x/pull/7", number: 7, draft: false, labels: ["a"], author: null }, source: "gh" } });
  assert.deepEqual(s.run.vars, { pr: "https://x/pull/7", number: "7", draft: "false", trigger: "gh.merged" });
  assert.equal(s.run.entries.b.event?.type, "gh.merged");
});
```

- [ ] **Step 2:** In `case "start"`, when `input.event` is set, after storing it on the first entry:

```ts
        for (const [k, v] of Object.entries(input.event.data)) {
          if (v !== null && v !== undefined && typeof v !== "object") run.vars[k] = String(v);
        }
        run.vars.trigger = input.event.type;
```

- [ ] **Step 3:** green; commit `feat(engine): a triggered run starts with the event data as vars`.

---

### Task 4: flowd keeps trigger subscriptions in sync

**Files:** Modify `src/daemon.ts`, `src/http.ts` (`listProcesses` adds `triggerErrors`), `test/daemon-helpers.ts` (test plugin); Test `test/daemon.test.ts`, `test/http.test.ts`

**Interfaces (produced):** `Flowd.triggerErrors(process: string): string[]` (`"<type>: <error>"` per failing subscription that lists the process); `/api/processes` items gain `triggerErrors`.

- [ ] **Step 1: Teach the test plugin about subscriptions.** In `TEST_PLUGIN` (`test/daemon-helpers.ts`), a run-less watch records itself instead of the wait list, can be told to throw, and exposes its `ctx` so a test can emit:

```ts
export const TEST_PLUGIN = `const g = globalThis as any;
export default {
  name: "test",
  events: ["ping"],
  watch(w: any, ctx: any) {
    if (!w.run) {
      if (w.with.fail) throw new Error("test cannot " + w.with.fail);
      (g.__flowsSubs ??= []).push(w);
      g.__flowsCtx = ctx;
      return () => { g.__flowsSubs = g.__flowsSubs.filter((x: any) => x !== w); };
    }
    (g.__flowsWatches ??= []).push(w.run + "/" + w.entry);
    return () => {};
  },
  actions: { post(args: any) { if (args.fail) throw new Error("post failed"); } },
};
`;
export const subs = (): any[] => ((globalThis as any).__flowsSubs ??= []);
export const pluginCtx = (): any => (globalThis as any).__flowsCtx;
export const resetSubs = () => { (globalThis as any).__flowsSubs = []; };
```

- [ ] **Step 2: Failing daemon tests:**

```ts
const TRIGGERED = (name: string, extra = "") =>
  proc("  - {step: c, role: human}\n", `triggers:\n  - {on: test.ping, with: {k: 1}${extra}}\n`, name);

test("processes with the same trigger share one subscription; its broadcast starts each of them", async () => {
  resetSubs();
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TRIGGERED("a"), ...TRIGGERED("b") }));
  assert.equal(subs().length, 1);
  assert.deepEqual(subs()[0].processes.sort(), ["a", "b"]);
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

test("a failing subscription shows on the process and in the plugin status", async () => {
  resetSubs();
  const s = await serve({ ...STEP_FILES, ...proc("  - {step: c, role: human}\n", "triggers:\n  - {on: test.ping, with: {fail: listen}}\n", "a") });
  const procs = (await s.call("GET", "/api/processes")).body;
  assert.deepEqual(procs[0].triggerErrors, ["test.ping: test cannot listen"]);
  const plugins = (await s.call("GET", "/api/plugins")).body.plugins;
  assert.deepEqual(plugins[0].watches, [{ run: null, entry: null, type: "test.ping", processes: ["a"], error: "test cannot listen" }]);
  await s.close();
});
```
(The last test goes in `test/http.test.ts`, using `serve` from `http-helpers.ts`.)

Run → FAIL.

- [ ] **Step 3: Implement in `src/daemon.ts`:**

```ts
  private syncSubscriptions(): void {
    const wanted = new Map<string, Watch>();
    for (const p of Object.values(this.defs.processes)) {
      for (const t of p.triggers) {
        if (!t.on || !this.plugins.loaded.has(t.on.split(".")[0])) continue; // flow.* and signal.* need no plugin
        const w: Watch = { type: t.on, with: t.with, cwd: expandHome(p.cwd), vars: {}, processes: [p.name] };
        const k = subscriptionKey(w);
        const same = wanted.get(k);
        if (same) same.processes!.push(p.name);
        else wanted.set(k, w);
      }
    }
    for (const k of this.plugins.subscriptionKeys()) if (!wanted.has(k)) this.plugins.unsubscribe(k);
    for (const [k, w] of wanted) {
      const have = this.plugins.subscription(k);
      if (have) have.processes = w.processes; // same subscription, possibly asked for by other processes now
      else this.plugins.watch(w);
    }
  }

  triggerErrors(process: string): string[] {
    return this.plugins.status().flatMap((p) => p.watches)
      .filter((w) => w.run === null && w.error && w.processes?.includes(process))
      .map((w) => `${w.type}: ${w.error}`);
  }
```
Call `this.syncSubscriptions()` at the end of `reloadDefs()` (every load, the first included). `close()` already stops every watch through `plugins.stopAll()` — confirm it covers subscriptions (it does once Task 1 iterates by stored key). Waits: wherever the daemon builds a wait `Watch` (`rearm`, `commit`), pass `cwd: expandHome(this.defs.processes[run.process]?.cwd ?? "~")`. In `src/http.ts` `listProcesses`, add `triggerErrors: f.triggerErrors(name)`.

- [ ] **Step 4:** green (all existing daemon tests unchanged); commit `feat(daemon): trigger subscriptions synced on every definitions load`.

---

### Task 5: gh repo mode — `gh.merged` for a repo, `gh.opened`, `gh.ci`

**Files:** Modify `plugins/gh.ts`; Test `test/gh.test.ts`

**Interfaces (produced):**
- `type Exec = (args: string[], cwd?: string) => Promise<{ code; stdout; stderr }>` (real exec runs `gh` with that `cwd`)
- `pollRepo(kind: "merged" | "opened" | "ci", w: { with: Dict; cwd?: string }, exec: Exec): Promise<{ id: string; outcome: "done" | "failed"; data: Dict }[]>` newest first, as `gh` lists them
- plugin `events: ["checks", "merged", "review", "opened", "ci"]`

Rules (from the spec):
- PR mode when `with.pr` is set, or for a wait (`w.run`) when `vars.pr` is set. `gh.checks`/`gh.review` need PR mode; otherwise throw `gh.checks needs a PR (vars.pr or with.pr); to start on CI results use gh.ci` (and `gh.review needs a PR (vars.pr or with.pr)`).
- Repo mode otherwise for `merged`; always for `opened` and `ci`. `gh.ci` without `with.branch` throws `gh.ci needs with.branch`. `with.repo` → `--repo <owner/name>`; without it `gh` runs in `w.cwd`.
- First repo-mode poll = baseline (remember the ids, emit nothing). Later polls emit every unseen id, oldest first. A wait emits the first and stops; a subscription keeps going.

- [ ] **Step 1: Failing tests** (extend the `fake` helper to record `cwd`):

```ts
const PR = (n: number, extra = {}) => ({ number: n, url: `https://g/pull/${n}`, title: `t${n}`, headRefName: `b${n}`, baseRefName: "main", author: { login: "me" }, labels: [], ...extra });

test("pollRepo merged/opened: pr list with filters, documented data", async () => {
  const exec = fake({ "pr list": { stdout: JSON.stringify([PR(2), PR(1)]) } });
  const items = await pollRepo("merged", { with: { base: "main", label: "x", repo: "o/r" }, cwd: "/w" }, exec);
  assert.deepEqual(exec.calls[0], ["pr", "list", "--repo", "o/r", "--state", "merged", "--limit", "30", "--json", "number,url,title,headRefName,baseRefName,author,labels", "--base", "main", "--label", "x"]);
  assert.deepEqual(items[1], { id: "1", outcome: "done", data: { pr: "https://g/pull/1", number: 1, title: "t1", branch: "b1", base: "main", author: "me" } });
  await pollRepo("opened", { with: {} }, exec);
  assert.deepEqual(exec.calls[1].slice(0, 4), ["pr", "list", "--state", "open"]);
});

test("pollRepo ci: completed runs only, outcome from conclusion", async () => {
  const runs = [
    { databaseId: 3, url: "u3", workflowName: "CI", conclusion: "", status: "in_progress", headSha: "s3", event: "push", headBranch: "main" },
    { databaseId: 2, url: "u2", workflowName: "CI", conclusion: "failure", status: "completed", headSha: "s2", event: "push", headBranch: "main" },
    { databaseId: 1, url: "u1", workflowName: "CI", conclusion: "success", status: "completed", headSha: "s1", event: "push", headBranch: "main" },
  ];
  const exec = fake({ "run list": { stdout: JSON.stringify(runs) } });
  const items = await pollRepo("ci", { with: { branch: "main", workflow: "CI" } }, exec);
  assert.deepEqual(exec.calls[0], ["run", "list", "--branch", "main", "--limit", "30", "--json", "databaseId,url,workflowName,conclusion,status,headSha,event,headBranch", "--workflow", "CI"]);
  assert.deepEqual(items.map((i) => [i.id, i.outcome]), [["2", "failed"], ["1", "done"]]);
  assert.deepEqual(items[0].data, { run: "u2", id: 2, workflow: "CI", conclusion: "failure", branch: "main", sha: "s2", event: "push" });
  await assert.rejects(pollRepo("ci", { with: {} }, exec), /gh\.ci needs with\.branch/);
});

test("a subscription baselines, then emits each new item oldest first, as a broadcast, forever", async () => {
  let list = [PR(1)];
  const exec = (async () => ({ code: 0, stdout: JSON.stringify(list), stderr: "" })) as Exec;
  const emitted: PluginEvent[] = [];
  const ctx: PluginCtx = { emit: (e) => emitted.push(e), log: () => {}, error: () => {}, config: { interval_ms: 5 } };
  const stop = makeGhPlugin(exec).watch!({ type: "gh.merged", with: {}, cwd: "/w", vars: {} }, ctx) as () => void;
  await sleep(15);
  list = [PR(3), PR(2), PR(1)];
  await sleep(15);
  list = [PR(4), PR(3), PR(2), PR(1)];
  await sleep(15);
  stop();
  assert.deepEqual(emitted.map((e) => [e.data!.number, e.run]), [[2, undefined], [3, undefined], [4, undefined]]);
});

test("a wait in repo mode emits once to its step and stops", async () => {
  let list = [PR(1)];
  const exec = (async () => ({ code: 0, stdout: JSON.stringify(list), stderr: "" })) as Exec;
  const emitted: PluginEvent[] = [];
  const ctx: PluginCtx = { emit: (e) => emitted.push(e), log: () => {}, error: () => {}, config: { interval_ms: 5 } };
  const stop = makeGhPlugin(exec).watch!({ type: "gh.opened", run: "p#1", entry: "w", with: {}, cwd: "/w", vars: {} }, ctx) as () => void;
  await sleep(15);
  list = [PR(3), PR(2), PR(1)];
  await sleep(30);
  stop();
  assert.deepEqual(emitted.map((e) => [e.data!.number, e.run, e.entry]), [[2, "p#1", "w"]]);
});

test("PR-only events refuse a subscription with a pointer to the right event", () => {
  const ctx: PluginCtx = { emit: () => {}, log: () => {}, error: () => {}, config: {} };
  assert.throws(() => makeGhPlugin(fake({})).watch!({ type: "gh.checks", with: {}, cwd: "/w", vars: {} }, ctx), /to start on CI results use gh\.ci/);
});

test("gh runs in the watch's cwd", async () => {
  const exec = fake({ "pr list": { stdout: "[]" } });
  await pollRepo("merged", { with: {}, cwd: "/w" }, exec);
  assert.equal(exec.cwds[0], "/w");
});
```
Existing gh tests: watches gain `cwd: "/w"`; the old "refuses a watch without a PR" test now uses `gh.checks` and the new message.

- [ ] **Step 2: Implement** `pollRepo` and the mode switch in `watch` (keep PR mode as it is):

```ts
const PR_FIELDS = "number,url,title,headRefName,baseRefName,author,labels";
const RUN_FIELDS = "databaseId,url,workflowName,conclusion,status,headSha,event,headBranch";

export async function pollRepo(kind: "merged" | "opened" | "ci", w: { with: Dict; cwd?: string }, exec: Exec) {
  const repo = w.with.repo ? ["--repo", String(w.with.repo)] : [];
  if (kind === "ci") {
    if (!w.with.branch) throw new Error("gh.ci needs with.branch");
    const args = ["run", "list", ...repo, "--branch", String(w.with.branch), "--limit", "30", "--json", RUN_FIELDS];
    if (w.with.workflow) args.push("--workflow", String(w.with.workflow));
    const rows = json(await exec(args, w.cwd), "run list") as Record<string, any>[];
    return rows.filter((r) => r.status === "completed").map((r) => ({
      id: String(r.databaseId), outcome: (r.conclusion === "success" ? "done" : "failed") as "done" | "failed",
      data: { run: r.url, id: r.databaseId, workflow: r.workflowName, conclusion: r.conclusion, branch: r.headBranch, sha: r.headSha, event: r.event },
    }));
  }
  const args = ["pr", "list", ...repo, "--state", kind === "merged" ? "merged" : "open", "--limit", "30", "--json", PR_FIELDS];
  if (w.with.base) args.push("--base", String(w.with.base));
  if (w.with.label) args.push("--label", String(w.with.label));
  const rows = json(await exec(args, w.cwd), "pr list") as Record<string, any>[];
  return rows.map((r) => ({
    id: String(r.number), outcome: "done" as const,
    data: { pr: r.url, number: r.number, title: r.title, branch: r.headRefName, base: r.baseRefName, author: r.author?.login ?? "" },
  }));
}
```
In `watch`: decide `prRef = String(w.with.pr ?? (w.run ? w.vars.pr ?? "" : ""))`, `repoMode = kind === "opened" || kind === "ci" || (kind === "merged" && !prRef)`; throw the documented messages for PR-only kinds without `prRef` and for `ci` without `branch` (before arming the timer). In repo mode keep `seen: Set<string> | null = null`; first poll sets it; later polls walk the items **reversed** (oldest first), emit each unseen one with `{type: w.type, run: w.run, entry: w.entry, outcome, data}`, add it to `seen`, and for a wait (`w.run`) stop after the first. Pass `w.cwd` to every `exec` call, PR mode included. `realExec` takes `cwd` and hands it to `execFile`.

- [ ] **Step 3:** green; commit `feat(gh): repo mode — gh.merged for a repo, gh.opened, gh.ci`.

---

### Task 6: UI — trigger `with`, trigger errors, subscriptions

**Files:** Modify `ui/app.js`

- [ ] **Step 1:** Trigger editor (`ProcessForm`): next to `where`, a `with` input with the same JSON-or-alert handling (`placeholder='with, JSON: {"base":"main"}'`), shown only for `on:` triggers.
- [ ] **Step 2:** Processes page: under a process, `p.triggerErrors` render like validation errors (`class="err"`), prefixed `trigger: `.
- [ ] **Step 3:** Plugins page: a watch row with `run === null` renders `trigger · ${w.processes.join(", ")}` (each a link to `#/process/<name>`) instead of a run link, plus its error.
- [ ] **Step 4:** `node --check ui/app.js && npm test`. Look at it on a throwaway daemon (temp `FLOWS_HOME`/`FLOWS_STATE`, port 7499) with a process `triggers: [{on: gh.checks}]` (no agent roles): the Processes page shows `trigger: gh.checks: gh.checks needs a PR …`; the Plugins page shows the subscription row. Screenshot both with agent-browser and look at them. Commit `feat(ui): trigger with, trigger errors, subscriptions on the plugins page`.

---

### Task 7: Documentation, skill, example

**Files:** Modify `docs/concepts.md`, `docs/processes.md`, `docs/plugins.md`, `skills/flow-author/SKILL.md`, `README.md` (only if a sentence there became untrue); Create `examples/processes/merged-followup.yaml` + its step file(s)

- [ ] **Step 1: concepts.md** — the Events/Triggers sections: waits and triggers are both subscriptions; a trigger subscription is run-less, shared by identical triggers, synced on every load, and its events are broadcasts; a triggered run's vars (`trigger` + scalar data); restart = new baseline, nothing caught up.
- [ ] **Step 2: processes.md** — trigger keys gain `with` (on: only, plain values, no templates); the vars a triggered run starts with; three recipes — merged PR on main, PR labelled `ready-for-agent`, CI failure on main — each run through `flow check` on a temp home before it goes into the doc.
- [ ] **Step 3: plugins.md** — `Watch` fields (`cwd`, optional `run`/`entry`, `processes`); how to tell a wait from a subscription; emit without `run` = broadcast; keep emitting for a subscription, emit once for a wait; throwing to refuse a mode. The gh section: the event table from the spec (modes, polled commands, data, outcome), baseline, `with.repo` vs `cwd`, `interval_ms`.
- [ ] **Step 4: flow-author skill** — the "Choosing an entry" table: "start on a plugin event" row with a `gh.opened` example; Traps: `gh.checks`/`gh.review` cannot be triggers (use `gh.ci`), history never fires, a trigger's `with` takes no templates.
- [ ] **Step 5: Example** `examples/processes/merged-followup.yaml` — triggered by `{on: gh.merged, with: {base: main}}`, an agent step (role `writer`) that writes release notes for `{{vars.pr}}` into the repo's `CHANGELOG.md` draft and a human approval step; `test/examples.test.ts` expects it.
- [ ] **Step 6:** `npm test && npm run typecheck` (docs test included). Commit `docs: plugin events as triggers — concepts, reference, gh, skill, example`.

---

### Task 8: Final check

- [ ] `npm test && npm run typecheck`; `git status` clean.
- [ ] Read concepts → processes → plugins → the skill as a stranger who wants "start a process when a PR is merged"; fix what does not lead there.
- [ ] Live check only with the user's yes and a repo they name: a throwaway daemon whose process triggers on `gh.merged` for that repo, a merge, the run appears. Without both, skip and say so.
- [ ] Report to the session that sent you the plan: branch, commits, test count, deviations from the plan, anything deferred to `docs/backlog/`.
