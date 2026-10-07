import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// plain browser JavaScript, no types: loaded by URL so tsc does not ask for declarations
const T: any = await import(new URL("../ui/text.js", import.meta.url).href);
const UI = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const base = (k: string) => k.replace(/\.(zero|one|two|few|many|other)$/, "");

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "agent", role: "dev", detour: false, waitFor: null, status: "pending", step: id, summary: `Do ${id}`,
  do: null, startedAt: null, note: null, onFail: "human", after: null, ...extra,
});
const run = (extra: Record<string, unknown> = {}, plan: any[] = [entry("a", { status: "done" }), entry("b", { status: "active", startedAt: 5_000 }), entry("c")]) => ({
  id: "p#1", process: "p", iteration: 1, status: "running", reason: null, current: "b", currentStatus: "active",
  currentKind: "agent", waitingOn: null, roles: { dev: "S1" }, vars: {}, needsYou: false, agentWait: null,
  created: 1_000, updated: 9_000, plan, ...extra,
});

test("both languages say everything, with every plural form their rules need", () => {
  const keys = (l: string) => [...new Set(Object.keys(T.DICT[l]).map(base))].sort();
  assert.deepEqual(keys("ru"), keys("en"));
  for (const l of T.LANGS) {
    for (const [k, v] of Object.entries(T.DICT[l])) assert.ok(String(v).trim(), `${l} ${k} is empty`);
    const forms = new Intl.PluralRules(l).resolvedOptions().pluralCategories;
    const plural = [...new Set(Object.keys(T.DICT[l]).filter((k) => k !== base(k)).map(base))];
    for (const k of plural) for (const f of forms) assert.ok(T.DICT[l][`${k}.${f}`], `${l} ${k}.${f} is missing`);
  }
});

test("every key the UI code asks for exists", () => {
  const used = new Set<string>();
  for (const f of readdirSync(UI).filter((n) => n.endsWith(".js"))) {
    for (const m of readFileSync(join(UI, f), "utf8").matchAll(/\btn?\("([a-zA-Z][\w.-]*)"/g)) used.add(m[1]);
  }
  const have = new Set(Object.keys(T.DICT.en).map(base));
  assert.deepEqual([...used].filter((k) => !have.has(k)), []);
});

test("the language: Russian browsers get Russian, everyone else English", () => {
  assert.equal(T.defaultLang("ru-RU"), "ru");
  assert.equal(T.defaultLang("ru"), "ru");
  assert.equal(T.defaultLang("en-US"), "en");
  assert.equal(T.defaultLang(undefined), "en");
  T.setLang("de");
  assert.equal(T.getLang(), "en");
});

test("durations at their boundaries", () => {
  T.setLang("en");
  assert.deepEqual([0, 59_000, 60_000, 59 * 60_000, 3_600_000, 70 * 60_000, 26 * 3_600_000, -5].map(T.duration),
    ["less than a minute", "less than a minute", "1 min", "59 min", "1 h", "1 h 10 min", "1 d", "less than a minute"]);
  assert.equal(T.ago(0, 120_000), "2 min ago");
  T.setLang("ru");
  assert.deepEqual([60_000, 70 * 60_000].map(T.duration), ["1 мин", "1 ч 10 мин"]);
  T.setLang("en");
});

test("counted phrases follow each language's plural rules", () => {
  T.setLang("ru");
  assert.deepEqual([1, 2, 5, 21].map((n) => T.tn("proc.steps", n)), ["1 шаг", "2 шага", "5 шагов", "21 шаг"]);
  T.setLang("en");
  assert.deepEqual([1, 2].map((n) => T.tn("proc.steps", n)), ["1 step", "2 steps"]);
});

test("event and entry phrases", () => {
  T.setLang("en");
  assert.equal(T.eventPhrase("gh.checks"), "GitHub checks");
  assert.equal(T.eventPhrase("signal.deploy"), "signal deploy");
  assert.equal(T.eventPhrase("acme.thing"), "acme.thing");
  assert.equal(T.entryPhrase(entry("x", { kind: "action", do: "clear", step: null, summary: null })), "dev starts fresh");
  assert.equal(T.entryPhrase(entry("x", { kind: "action", do: "slack.post", role: null, step: null, summary: null })), "Action slack.post");
  assert.equal(T.entryPhrase(entry("ci", { kind: "wait", role: null, waitFor: "gh.checks", step: null, summary: null })), "Waiting for GitHub checks");
  assert.equal(T.entryPhrase(entry("fix", { summary: "The dev fixes red CI" })), "The dev fixes red CI");
  assert.equal(T.entryPhrase(entry("fix", { summary: null })), "fix");
  assert.equal(T.runLabel("pr-loop#4"), "pr-loop · run 4");
  assert.equal(T.runLabel("odd"), "odd");
});

test("describeRun covers every situation, and its 'you' tone matches needsYou", () => {
  T.setLang("en");
  const cases: [string, any, any][] = [
    ["working", run(), { tone: "work", tag: "Agent working", title: "Do b", detail: null }],
    ["failed", run({ status: "needs-human", reason: "no push rights", needsYou: true }, [entry("a", { status: "done" }), entry("b", { status: "failed" })]),
      { tone: "you", tag: "Stopped", title: "Step “Do b” did not work out", detail: "no push rights" }],
    ["stopped", run({ status: "needs-human", reason: "the session closed", needsYou: true }),
      { tone: "you", tag: "Stopped", title: "The run stopped and waits for you", detail: "the session closed" }],
    ["human step", run({ needsYou: true, waitingOn: "gh.merged", currentKind: "human" }, [entry("b", { kind: "human", role: "human", status: "waiting" })]),
      { tone: "you", tag: "Your step", title: "Do b", detail: "Closes by itself once the PR merge arrives" }],
    ["agent asks", run({ needsYou: true, agentWait: { note: "pick findings", human: true, since: 7_000 } }),
      { tone: "you", tag: "Agent asks", title: "dev waits for you", detail: "pick findings" }],
    ["agent waits", run({ agentWait: { note: "tests running", human: false, since: 7_000 } }),
      { tone: "wait", tag: "Agent waits", title: "Do b", detail: "waiting: tests running" }],
    ["event wait", run({ current: "ci", waitingOn: "gh.checks" }, [entry("ci", { kind: "wait", role: null, waitFor: "gh.checks", status: "waiting", step: null, summary: null })]),
      { tone: "wait", tag: "Waiting", title: "Waiting for GitHub checks", detail: null }],
    ["queued for a hold", run({ heldBy: { hold: "desk", run: "p#1" } }, [entry("b", { status: "waiting" })]),
      { tone: "wait", tag: "Waiting", title: "Waits for desk: p#1 has it", detail: null }],
    ["paused", run({ status: "paused" }), { tone: "calm", tag: "Paused", title: "Do b", detail: null }],
    ["done", run({ status: "done", current: null }), { tone: "calm", tag: "Finished", title: "Finished", detail: null }],
    ["stopped by you", run({ status: "stopped", current: null }), { tone: "calm", tag: "Stopped", title: "Stopped by you", detail: null }],
  ];
  for (const [name, r, want] of cases) {
    assert.deepEqual(T.describeRun(r), want, name);
    assert.equal(want.tone === "you", r.needsYou, `${name}: tone vs needsYou`);
  }
});

test("waitingSince is the moment a person was first needed", () => {
  assert.equal(T.waitingSince(run({ status: "needs-human" })), 9_000);
  assert.equal(T.waitingSince(run({ agentWait: { note: "x", human: true, since: 7_000 } })), 7_000);
  assert.equal(T.waitingSince(run({}, [entry("b", { kind: "human", role: "human", status: "active", startedAt: 5_000 })])), 5_000);
});

test("progress counts main entries and places a detour after the last finished one", () => {
  assert.deepEqual(T.progress(run()), { i: 2, n: 3, segs: ["done", "cur", "todo"] });
  const detour = run({ current: "fix" }, [entry("a", { status: "done" }), entry("ci", { status: "failed" }), entry("m"), entry("fix", { detour: true, status: "active" })]);
  assert.deepEqual(T.progress(detour), { i: 2, n: 3, segs: ["done", "cur", "todo"] });
  assert.deepEqual(T.progress(run({ status: "done", current: null }, [entry("a", { status: "done" })])), { i: 1, n: 1, segs: ["done"] });
});

test("branch lines say where an entry leads besides next", () => {
  T.setLang("en");
  const plan = [entry("impl"), entry("review", { onFail: { goto: "impl" } }), entry("ci", { kind: "wait", waitFor: "gh.checks", onFail: { goto: "fix" } }),
    entry("fix", { detour: true, after: { goto: "ci" } }), entry("x", { onFail: "retry" })];
  assert.deepEqual(plan.map((e) => T.entryBranch(e, plan)),
    [[], ["If it fails → back to “Do impl”"], ["If it fails → “Do fix”"], ["Then → “Waiting for GitHub checks”"], ["If it fails → it tries again"]]);
});

test("events become short sentences; the rest stay in the full history", () => {
  T.setLang("en");
  const plan = [entry("b"), entry("m", { kind: "human", role: "human" }), entry("ci", { kind: "wait", role: null, waitFor: "gh.checks" })];
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ id: 1, ts: 0, type, data: {}, source: "x", ...extra });
  assert.equal(T.eventSentence(ev("entry.delivered", { entry: "b" }), plan), "dev got the task");
  assert.equal(T.eventSentence(ev("flow.step.done", { data: { entry: "b", note: "did it" } }), plan), "dev finished: “did it”");
  assert.equal(T.eventSentence(ev("flow.step.done", { data: { entry: "m" } }), plan), "You finished");
  const act = [entry("lead", { kind: "action", do: "clear", role: "lead" })];
  assert.equal(T.eventSentence(ev("flow.step.done", { data: { entry: "lead" } }), act), "lead starts fresh");
  assert.equal(T.eventSentence(ev("flow.step.failed", { data: { entry: "b", note: "red" } }), plan), "dev failed: “red”");
  assert.equal(T.eventSentence(ev("gh.checks", { entry: "ci", outcome: "failed" }), plan), "GitHub checks: failed");
  assert.equal(T.eventSentence(ev("run.set"), plan), "Run details updated");
  assert.equal(T.eventSentence(ev("run.start"), plan), "The run started");
  assert.equal(T.eventSentence(ev("flow.iteration.done", { data: { iteration: 3 } }), plan), "Round 3 finished");
  assert.equal(T.eventSentence(ev("agterm.status"), plan), null);
});

test("process facts", () => {
  T.setLang("en");
  assert.deepEqual(T.processFacts({ repeat: true, maxRuns: 3, triggers: [], cwd: "~/code" }),
    ["Repeats in rounds", "Up to 3 runs at once", "Started by hand", "Works in ~/code"]);
  assert.deepEqual(T.processFacts({ repeat: false, maxRuns: 1, triggers: [{ on: "gh.merged" }, { cron: "0 9 * * 1-5" }], cwd: "" }),
    ["One run at a time", "Starts by itself on the PR merge · Starts on schedule 0 9 * * 1-5"]);
});

test("roundsEnded reads a run's events: rounds that ended, newest first, with the note of the step that ended each", () => {
  const ev = (id: number, type: string, data: Record<string, unknown>) => ({ id, ts: id * 1000, type, data, source: "flow" });
  const events = [
    ev(6, "flow.step.done", { entry: "pick", note: "wave 3" }),
    ev(5, "flow.iteration.done", { iteration: 2 }),
    ev(4, "flow.step.done", { entry: "wrap", note: "wave 2 merged" }),
    ev(3, "entry.delivered", {}),
    ev(2, "flow.iteration.done", { iteration: 1 }),
    ev(1, "flow.step.done", { entry: "wrap", note: "" }),
  ];
  assert.deepEqual(T.roundsEnded(events), [
    { iteration: 2, at: 5_000, note: "wave 2 merged" },
    { iteration: 1, at: 2_000, note: null },
  ]);
  assert.deepEqual(T.roundsEnded([]), []);
});

test("runTitle: what a run works on is its title var, trimmed; nothing when it is missing or blank", () => {
  assert.equal(T.runTitle(run({ vars: { title: "  Fix the login timeout " } })), "Fix the login timeout");
  assert.equal(T.runTitle(run({ vars: { title: "   " } })), null);
  assert.equal(T.runTitle(run({ vars: {} })), null);
  // a conventional-commit PR title reads as plain words; the full one stays in the tooltip
  assert.equal(T.runTitle(run({ vars: { title: "fix(login): [ABC-123] stop the session timing out early" } })), "Stop the session timing out early");
  assert.equal(T.runTitle(run({ vars: { title: "refactor(store)!: [ABC-9] wave 61 — type the actions" } })), "Wave 61 — type the actions");
  assert.equal(T.runTitle(run({ vars: { title: "Fix the login timeout" } })), "Fix the login timeout");
  assert.equal(T.runTitle(run({ vars: { title: "fix: [ABC-1]" } })), "fix: [ABC-1]");
});
