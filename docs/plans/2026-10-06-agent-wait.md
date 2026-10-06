# `flow wait` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent end its turn on purpose with `flow wait --note "…"` so a step that legitimately spans several turns is neither reminded nor halted, and show such waits to the user.

**Architecture:** A per-entry `wait` record in the engine with a two-phase rule (declared → parked → used up by the next `active`), a new `wait` engine input fed by an `entry.wait` event, `POST /api/wait`, `flow wait`, and `agentWait` on run summaries for the UI and CLI.

**Tech Stack:** unchanged.

**Spec:** `docs/specs/2026-10-06-agent-wait-design.md`. Follow `CLAUDE.md`.

## Global Constraints

- Read the current files first; snippets show the logic, line numbers drift.
- Existing reminder behaviour without a wait must not change: the existing engine and daemon reminder tests stay green unchanged, except for the reminder text, which they read through `reminderText()`.
- Fakes only in tests; never the real agterm, `~/.config/flows`, `~/.claude` or launchd. CLI tests set `AGTERM_SESSION_ID` explicitly.
- `npm test` and `npm run typecheck` green after every task; one commit per task, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. `flow wait` mid-turn, then a duplicate `active`, then the turn end, then a duplicate idle from resync → no reminder, wait still parked. (Task 1)
2. The agent's next turn begins and it ends again without reporting → reminded as today. (Task 1)
3. Five legitimate waits in one step → the run is never halted. (Task 1)
4. `flow wait --run --step` from the user's own terminal session → parked at once, not stuck in "declared". (Task 2)
5. The entry `timeout` still fails a step whose agent is waiting. (Task 1)

---

### Task 1: Engine — the wait record and the turn rule

**Files:** Modify `src/types.ts`, `src/engine.ts`; Test `test/engine-runtime.test.ts`

**Interfaces (produced):**
- `interface AgentWait { note: string; human: boolean; since: number; parked: boolean }`; `EntryState.wait?: AgentWait`
- `Input` gains `{ kind: "wait"; entry: string; note: string; human: boolean; sessionActive: boolean }`
- `reminderText(entry)` returns ``▶ flow: step <entry> is not closed — `flow done`, `flow failed --note "…"`, or `flow wait --note "…"` if you are waiting on purpose``

- [ ] **Step 1: Failing tests** in `test/engine-runtime.test.ts` (reuse its `LINEAR`, `STEPS`, `Sim`, `rep`):

```ts
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
```
Run `npm test` → FAIL.

- [ ] **Step 2: Implement.**
  - `src/types.ts`: `AgentWait`, `EntryState.wait?`, the `wait` input.
  - `src/engine.ts`:
    - `reminderText` → the new text.
    - `enter()`, `recover()` and `finish()` clear `s.wait` (in `enter` add `wait: undefined` to the `Object.assign`).
    - New case, next to `report`:

```ts
    case "wait": {
      if (input.entry !== curId) return fail(`step ${input.entry} is not the current step (current: ${curId ?? "none"})`);
      const s = st(curId);
      if (cur!.kind !== "agent") return fail(`flow wait is for an agent's step; ${curId} is a ${cur!.kind} step`);
      if (s.status !== "active") return fail(`step ${curId} is not active (${s.status})`);
      if (s.deliveredAt === undefined) return fail(`step ${curId} has not reached the agent yet`);
      if (!input.note) return fail("flow wait needs --note saying what you are waiting for");
      // declared mid-turn it parks on the turn end; declared after the turn (or from another
      // terminal) no turn end will follow, so it is parked already
      s.wait = { note: input.note, human: input.human, since: now, parked: !input.sessionActive };
      s.reminded = 0;
      s.remindAt = undefined;
      return done();
    }
```
    - In `case "session"`, replace the active / completed-idle branch:

```ts
      if (input.status === "active") {
        if (s.wait?.parked) s.wait = undefined; // the agent's next turn began: the wait is used up
        s.sawActive = true;
        s.remindAt = undefined;
      } else if (input.status === "completed" || input.status === "idle") {
        if (s.wait) {
          s.wait.parked = true; // the turn the wait was declared in ended; repeats change nothing
          s.remindAt = undefined;
        } else if (s.sawActive) {
          s.remindAt = now + REMIND_AFTER_MS;
        }
      }
```

- [ ] **Step 3:** green (existing reminder tests untouched); commit `feat(engine): flow wait — a declared wait parks on the turn end and is used up by the next turn`.

---

### Task 2: Daemon, HTTP, CLI

**Files:** Modify `src/daemon.ts`, `src/http.ts`, `src/cli.ts`; Test `test/daemon.test.ts`, `test/http.test.ts`, `test/cli.test.ts`

**Interfaces (produced):**
- event `entry.wait` with `data: {session?, run?, entry?, note, human?}`
- `POST /api/wait {session? | run+entry, note, human?}` → `{run}`; refusals 409 `{error}`
- `flow wait --note T [--human] [--run ID --step ID]` → prints `waiting: <note>`; without `--note`: `flow: flow wait needs --note saying what you are waiting for`, exit 1
- `RunSummary.agentWait: { note: string; human: boolean; since: number } | null`; `needsYou` is also true for a `human` wait
- `flow show` prints `waiting since <ISO time>: <note>` after its header line when the entry has a wait; `flow ls` shows `<entry> (<status>, waiting: <note>)`

- [ ] **Step 1: Failing tests.**

`test/daemon.test.ts`:
```ts
test("flow wait from the agent's own session parks on its turn end; nothing but the nudge is typed", async () => {
  const { f, clock, agterm } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1") });
  await f.submit(start("p", { pm: "S1" }));
  await settle(f);
  await f.submit(status("S1", "active"));
  assert.deepEqual(await f.submit({ type: "entry.wait", data: { session: "S1", note: "review running" }, source: "cli" }), { run: "p#1" });
  assert.equal(f.store.getRun("p#1")!.entries.b.wait?.parked, false);
  await f.submit(status("S1", "completed"));
  clock.t += 120_000;
  await f.tickNow();
  await settle(f);
  assert.equal(agterm.typed().length, 1);
  const summary = f.runSummary(f.store.getRun("p#1")!);
  assert.equal(summary.agentWait?.note, "review running");
  assert.equal(summary.needsYou, false);
  await f.close();
});

test("a wait sent with --run/--step from another session starts parked; --human puts the run under needs-you", async () => {
  const { f } = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }), { agterm: new FakeAgterm().addSession("S1", "ME") });
  await f.submit(start("p", { pm: "S1" }));
  await settle(f);
  await f.submit(status("S1", "active"));
  await f.submit({ type: "entry.wait", data: { session: "ME", run: "p#1", entry: "b", note: "user reads the PR", human: true }, source: "cli" });
  const run = f.store.getRun("p#1")!;
  assert.equal(run.entries.b.wait?.parked, true);
  assert.equal(f.runSummary(run).needsYou, true);
  await f.close();
});
```

`test/http.test.ts`: `POST /api/wait {session: "S9", note: "x"}` → 409 `no open run is bound to this session`; after a start and `settle`, `POST /api/wait {session: "S1", note: "x"}` → 200 and `GET /api/runs` shows `agentWait.note === "x"`.

`test/cli.test.ts` (inside the existing agent-session test or a new one): `flow wait` → exit 1, stderr `flow: flow wait needs --note saying what you are waiting for\n`; `flow wait --note "review running"` → exit 0, stdout `waiting: review running\n`; `flow show` stdout matches `/^waiting since .*: review running$/m`; `flow ls` matches `/b \(active, waiting: review running\)/`.

Run → FAIL.

- [ ] **Step 2: Implement.**

`src/daemon.ts`, in `handle()` next to `entry.report`:
```ts
      case "entry.wait": {
        const t = this.resolveTarget(d);
        if ("error" in t) return t;
        const run = this.store.getRun(t.run);
        const role = run ? this.currentEntry(run)?.role : undefined;
        const bound = run && role ? run.roles[role] : null;
        // only the agent's own session, seen active, can be mid-turn; anything else parks at once
        const sessionActive = Boolean(bound) && d.session === bound && this.store.sessionStatus(bound!) === "active";
        return this.apply(t.run, { kind: "wait", entry: t.entry, note: String(d.note ?? ""), human: d.human === true, sessionActive });
      }
```
`runSummary`: `agentWait: s?.wait ? { note: s.wait.note, human: s.wait.human, since: s.wait.since } : null`, and `needsYou` gains `|| Boolean(s?.wait?.human)`. `show()`: after the header line, `if (s?.wait) lines.push(\`waiting since ${new Date(s.wait.since).toISOString()}: ${s.wait.note}\`)`.

`src/http.ts`:
```ts
    ["POST", /^\/api\/wait$/, (_p, b) => submit({
      type: "entry.wait",
      data: { session: b.session, run: b.run, entry: b.entry, note: b.note, human: b.human === true },
      source: "cli",
    })],
```

`src/cli.ts`: HELP gains `  flow wait --note T [--human]           end your turn on purpose (no reminder until your next turn)`; a case:
```ts
      case "wait": {
        if (!a.note) throw new CliError("flow wait needs --note saying what you are waiting for");
        await call("POST", "/api/wait", { session, run: a.run, entry: a.step, note: a.note, human: a.human });
        out(`waiting: ${a.note}`);
        return 0;
      }
```
and `ls` prints `${r.current} (${r.currentStatus}${r.agentWait ? `, waiting: ${r.agentWait.note}` : ""})`.

- [ ] **Step 3:** green; commit `feat: flow wait — entry.wait event, /api/wait, CLI, agentWait in run summaries`.

---

### Task 3: UI

**Files:** Modify `ui/app.js`

- [ ] **Step 1:** Runs list (`RunRow`): when `r.agentWait`, the current-entry cell reads `<b>b</b> active · waiting: <note>` (a `human` wait already lands in "Needs you" through `needsYou`).
- [ ] **Step 2:** Run page: in the plan strip the current entry shows `⏸` instead of `▶` when `r.agentWait`; the entry panel shows `waiting since <local time>: <note>` (and `— on a human` for a human wait).
- [ ] **Step 3:** `node --check ui/app.js && npm test`. Then look at it on a throwaway flowd that cannot reach the real agterm — a fake `agtermctl` answers every call:

```bash
T=$(mktemp -d); mkdir -p "$T/home/processes" "$T/home/steps"
cat > "$T/agtermctl" <<'EOF'
#!/bin/sh
case "$1 $2" in
  "session new") echo '{"ok":true,"result":{"id":"FAKE1"}}' ;;
  "tree --json") echo '{"ok":true,"result":{"tree":{"workspaces":[]}}}' ;;
esac
EOF
chmod +x "$T/agtermctl"
printf -- '---\nsummary: wait for the user\n---\nWait.\n' > "$T/home/steps/w.md"
printf 'description: wait demo\ncwd: /tmp\nroles: {pm: {spawn: "true"}}\nsteps:\n  - {step: w, role: pm}\n' > "$T/home/processes/waits.yaml"
FLOWS_AGTERMCTL="$T/agtermctl" FLOWS_HOME="$T/home" FLOWS_STATE="$T/db" FLOWD_PORT=7499 node src/cli.ts daemon & D=$!
sleep 1; export FLOWD_URL=http://127.0.0.1:7499
node src/cli.ts start waits; sleep 2   # spawn goes to the fake; the nudge counts as delivered
node src/cli.ts wait --run 'waits#1' --step w --note "user reads the PR in revdiff" --human
```
Screenshot `#/runs` and `#/run/waits%231` with agent-browser and look at them; then `kill $D`. Commit `feat(ui): show an agent's declared wait`.

---

### Task 4: Documentation

**Files:** Modify `docs/concepts.md`, `docs/cli.md`, `docs/http-api.md`, `docs/troubleshooting.md`, `skills/flow/SKILL.md`, `skills/flow-author/SKILL.md`, `README.md` (only if a sentence there became untrue)

- [ ] **Step 1: concepts.md**, "Reminders and timeouts": the turn rule in plain words — a wait covers the turn end that follows it and every repeat of it, and is used up when the agent's next turn begins; `reminded` resets on a wait; the timeout still applies; a turn agterm never sees does not use it up; a human wait shows under "Needs you".
- [ ] **Step 2: cli.md** `flow wait` (synopsis, flags, output, exit codes, example); **http-api.md** `POST /api/wait`, `agentWait` in run summaries.
- [ ] **Step 3: skills/flow/SKILL.md** — a short section: when your step tells you to wait for something (a background job, the user in a viewer), run `flow wait --note "<what>"` (add `--human` when the user must act) before ending your turn; when you come back, finish with `flow done`/`flow failed`, or wait again with a fresh note. Never end a turn without one of the three.
- [ ] **Step 4: skills/flow-author/SKILL.md** — step prompts that send the agent to wait must say to run `flow wait --note …` first; and a Traps line: a waiting step still has its `timeout`.
- [ ] **Step 5: troubleshooting.md** — "A run stopped with 'the agent ended its turn N times'": the agent waited without `flow wait`; fix the step prompt; then `retry` or `done` from the UI.
- [ ] **Step 6:** `npm test && npm run typecheck`; commit `docs: flow wait`.

---

### Task 5: Final check

- [ ] `npm test && npm run typecheck`; `git status` clean.
- [ ] Live check only with the user's yes: a throwaway flowd and one real agent session, a step telling the agent to `flow wait --note "waiting for you"` and end its turn; confirm no reminder appears; type into the session so a new turn starts, let it end without a report, and confirm the reminder now arrives. Note whether a turn started by a background-task notification shows as `active` in agterm. Without a yes, skip and say so.
- [ ] Report to the session that sent you the plan: branch, commits, test count, deviations, anything added to `docs/backlog/`.
