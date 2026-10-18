// A throwaway flowd for looking at the web UI: a temp $FLOWS_HOME, a fake agterm, a stub gh
// plugin, and runs pushed into every state the UI draws. It never touches the real flowd,
// agterm or ~/.config/flows. Run: node scripts/ui-preview.ts → http://127.0.0.1:7421
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Flowd } from "../src/daemon.ts";
import { makeServer } from "../src/http.ts";
import { FakeAgterm, makeHome, settle } from "../test/daemon-helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PREVIEW_PORT || 7421);
const step = (summary: string, body: string) => `---\nsummary: ${JSON.stringify(summary)}\n---\n${body}\n`;

// a translator that takes a moment, like the real one, and never reaches codex
const SLOW_TRANSLATE = [process.execPath, "-e",
  'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => setTimeout(() => process.stdout.write("[RU] " + s), 1500));'];

const files: Record<string, string> = {
  "plugins/gh.ts": `export default { name: "gh", events: ["checks", "merged", "review", "opened", "ci"], watch() { return () => {}; }, actions: {} };\n`,
  "steps/pick.md": step("The lead picks the next task and prepares a worktree for it", "Pick the next task from docs/backlog/, create a worktree for it, then `flow done`."),
  "steps/implement.md": step("The dev implements the task in its worktree and commits", "Implement the task test-first, commit, then `flow done`."),
  "steps/review.md": step("The lead reviews the dev's commits", "Review the new commits. Something to fix: `flow failed --note \"…\"`."),
  "steps/open-pr.md": step("The lead pushes the branch and opens the PR", "Push and open a PR with `gh pr create`, then `flow done --evidence <url>`."),
  "steps/merge.md": step("You review and merge the PR on GitHub", "Review and merge the PR. The merge closes this step by itself."),
  "steps/ci-fix.md": step("The dev fixes red CI", "Read the failed checks with `gh pr checks`, fix the cause, push, `flow done`."),
  "steps/draft.md": step("The writer drafts a changelog entry for the merged PR", "Add one entry to CHANGELOG.md for the merged PR and push it."),
  "steps/approve.md": step("You read the changelog draft and commit it", "Read the new entry, edit it if needed, commit, press Done."),
  "steps/hello.md": step("The agent says hello", "Say hello, then `flow done`."),
  "steps/check.md": step("You check the run page and press Done", "Look at the run page and press Done."),
  "processes/review-loop.yaml": `description: One task per round — the lead picks and reviews, the dev codes, GitHub checks run, you merge
cwd: ~/code/my-repo
repeat: true
max_runs: 3
roles:
  lead: {spawn: claude}
  dev: {spawn: claude}
steps:
  - {id: lead-fresh, do: clear, role: lead}
  - {step: pick, role: lead}
  - {step: implement, role: dev}
  - {step: review, role: lead, on_fail: {goto: implement}}
  - {step: open-pr, role: lead}
  - {id: ci, wait_for: gh.checks, on_fail: {goto: ci-fix}}
  - {step: merge, role: human, wait_for: gh.merged}
  - {step: ci-fix, role: dev, detour: true, after: {goto: ci}}
`,
  "processes/changelog.yaml": `description: For each merged PR the writer drafts a changelog entry and you approve it
cwd: ~/code/my-repo
max_runs: 3
triggers:
  - {on: gh.merged, with: {base: main}}
roles:
  writer: {spawn: claude}
steps:
  - {step: draft, role: writer, retries: 0}
  - {step: approve, role: human}
`,
  "processes/hello.yaml": `description: Smoke test — an agent says hello, then you check
cwd: /tmp
max_runs: 3
roles:
  agent: {spawn: claude}
steps:
  - {step: hello, role: agent}
  - {step: check, role: human}
`,
  "steps/tracker-find.md": step("The dev finds or creates the tracker issue", "Find the issue for this work, or create one; `flow set issue=<KEY>`, `flow done`."),
  "steps/tracker-close.md": step("The dev moves the issue to Done and links the PR", "Move {{vars.issue}} to Done, add {{vars.pr}} to it, `flow done`."),
  "steps/report-sum.md": step("The dev posts a summary to the team thread", "Post what was done to the thread, `flow done`."),
  "processes/pr.yaml": `description: Open the PR, wait for CI, you merge
cwd: ~/code/my-repo
max_runs: 5
roles:
  dev: {spawn: claude}
steps:
  - {step: open-pr, role: dev}
  - {id: ci, wait_for: gh.checks, on_fail: {goto: ci-fix}}
  - {step: merge, role: human, wait_for: gh.merged}
  - {step: ci-fix, role: dev, detour: true, after: {goto: ci}}
`,
  "processes/tracker.yaml": `description: Find the tracker issue, let another process do the work, move the issue to Done
cwd: ~/code/my-repo
max_runs: 5
roles:
  dev: {spawn: claude}
steps:
  - {step: tracker-find, role: dev}
  - {inner: true, role: dev}
  - {step: tracker-close, role: dev}
`,
  "processes/report.yaml": `description: Let another process do the work, then tell the team
cwd: ~/code/my-repo
max_runs: 5
roles:
  dev: {spawn: claude}
steps:
  - {inner: true, role: dev}
  - {step: report-sum, role: dev}
`,
  "steps/deliver.md": step("The dev deploys the PR branch to the test desk", "Deploy the PR branch to the shared test desk with `desk deploy {{vars.pr}}`.\nWait until the desk answers on /health with the PR's head sha.\n\nDone: `flow done --note \"<sha>\"`."),
  "steps/feedback.md": step("The dev reacts to the team's review; done once approved and green", "A review arrived on {{vars.pr}}. Read every comment. Fix what is right, answer what is not,\nresolve each thread you handled. Push, then ask for a new look.\n\nApproved and green: `flow done`. Changes requested again: `flow failed` — flows waits for the next review."),
  "processes/pr-full.yaml": `description: Take a finished branch to merge — PR, the shared test desk, CI, team review
cwd: /tmp
max_runs: 3
roles:
  dev: {spawn: claude}
  peer: {spawn: codex, beside: dev}
steps:
  - {id: codex, do: type, role: peer, text: ""}
  - {step: open-pr, role: dev}
  - {step: deliver, role: dev, timeout: 1h, hold: desk}
  - {id: ci, wait_for: gh.checks, on_fail: {goto: ci-fix}}
  - {step: ci-fix, role: dev}
  - {id: label, sh: 'gh pr edit "$FLOW_VAR_PR" --add-label ready', timeout: 5m}
  - {step: feedback, role: dev, wait_for: {on: gh.review, with: {from: requested, already: true}}, on_fail: retry, retries: 50}
  - {inner: true, role: dev}
  - {step: merge, role: human, wait_for: gh.merged}
  - {id: tail, wait: 20h}
  - {step: hello, role: dev, on_fail: end}
`,
  "processes/broken.yaml": "cwd: /tmp\nsteps:\n  - {step: nope, role: ghost}\n",
};

const home = makeHome(files);
const agterm = new FakeAgterm().addSession("L1", "D1", "L2", "D2", "L3", "D3", "W1", "W2", "A1", "A2", "T1", "T2", "T3");
const f = new Flowd({ home, statePath: join(home, "state.db"), agterm, pluginDirs: [join(home, "plugins")], spawnGraceMs: 0, gapMs: 0, watchDefs: false, translate: SLOW_TRANSLATE, claudeConfig: join(home, "no-claude.json"), log: () => {} });
await f.init();

const start = async (proc: string, bind: Record<string, string>, inner?: string[]) => {
  const r = await f.submit({ type: "run.start", data: { process: proc, bind, inner }, source: "preview" });
  await settle(f);
  if (!r.run) throw new Error(`could not start ${proc}: ${r.error}`);
  return r.run;
};
const report = async (run: string, entry: string, note: string, outcome = "done") => {
  await f.submit({ type: "entry.report", data: { run, entry, outcome, note, by: "human" }, source: "preview" });
  await settle(f);
};
const status = async (session: string, s: string) => {
  await f.submit({ type: "agterm.status", data: { session, status: s }, source: "preview" });
  await settle(f);
};
const files15 = Array.from({ length: 15 }, (_, i) => `src/features/reports/exporters/very/long/path/to/module-${i}.ts`).join(" ");

// waiting for you: a human step that closes by itself once the PR merges
const r1 = await start("review-loop", { lead: "L1", dev: "D1" });
await report(r1, "pick", "Took docs/backlog/csv-export.md");
await f.submit({ type: "run.set", run: r1, data: { vars: { task: "CSV export", title: "Export the monthly report as CSV", pr: "https://github.com/acme/app/pull/142", files: files15 } }, source: "preview" });
await report(r1, "implement", "4 commits, tests green");
await report(r1, "review", "Looks good");
await report(r1, "open-pr", "https://github.com/acme/app/pull/142");
await report(r1, "ci", "checks green");
// an agent at work
const r2 = await start("review-loop", { lead: "L2", dev: "D2" });
await report(r2, "pick", "Took docs/backlog/xlsx-import.md");
await f.submit({ type: "run.set", run: r2, data: { vars: { title: "Import customers from an XLSX file" } }, source: "preview" });
await settle(f);
await status("D2", "active");
// waiting for GitHub checks
const r3 = await start("review-loop", { lead: "L3", dev: "D3" });
for (const e of ["pick", "implement", "review", "open-pr"]) await report(r3, e, `${e} done`);
// a step that did not work out, with a long reason
const r4 = await start("changelog", { writer: "W1" });
await f.submit({ type: "run.set", run: r4, data: { vars: { title: "Fix the login timeout", pr: "https://github.com/acme/api/pull/136", slack_thread: "https://acme.slack.com/archives/C0123/p1700000000" } }, source: "preview" });
await settle(f);
await report(r4, "draft", "no permission to push to main — git push was rejected by the protected-branch rule on acme/app; "
  + "the writer's token has contents:read only. Either grant contents:write or let the draft go to a branch.", "failed");
// an agent asking for you
const r5 = await start("hello", { agent: "A1" });
await status("A1", "active");
await f.submit({ type: "entry.wait", data: { run: r5, entry: "hello", note: "Pick the findings in revdiff", human: true, session: "A1" }, source: "preview" });
await settle(f);
// finished
const r6 = await start("hello", { agent: "A2" });
await report(r6, "hello", "said hello");
await report(r6, "check", "looked fine");

// nested: a PR process inside a tracker process (two levels), inside a report too (three), and a
// tracker waiting for the person to choose what runs inside
const r8 = await start("tracker", { dev: "T1" }, ["pr"]);
await f.submit({ type: "run.set", run: r8, data: { vars: { issue: "PROJ-12", title: "Speed up the report page" } }, source: "preview" });
await report(r8, "tracker-find", "PROJ-12");
const r8c = f.store.getRun(r8)!.entries.inner.child!;
await report(r8c, "open-pr", "https://github.com/acme/app/pull/150");
const r9 = await start("report", { dev: "T2" }, ["tracker", "pr"]);
const r9t = f.store.getRun(r9)!.entries.inner.child!;
await report(r9t, "tracker-find", "PROJ-15");
await status("T2", "active");
const r10 = await start("tracker", { dev: "T3" });
await f.submit({ type: "run.set", run: r10, data: { vars: { title: "Drop an unused settings flag" } }, source: "preview" });
await report(r10, "tracker-find", "PROJ-17");

const server = makeServer(f, join(ROOT, "ui"));
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${port}`;
// stopped, through the API the UI uses
const r7 = await start("changelog", { writer: "W2" });
await fetch(`${base}/api/runs/${encodeURIComponent(r7)}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
await settle(f);

const expected: [string, (s: ReturnType<Flowd["runSummary"]>) => boolean][] = [
  [r1, (s) => s.current === "merge" && s.needsYou],
  [r2, (s) => s.current === "implement" && !s.needsYou],
  [r3, (s) => s.current === "ci" && s.waitingOn === "gh.checks"],
  [r4, (s) => s.status === "needs-human"],
  [r5, (s) => s.needsYou && s.agentWait?.human === true],
  [r6, (s) => s.status === "done"],
  [r7, (s) => s.status === "stopped"],
  [r8, (s) => s.current === "inner" && s.child === r8c && !s.needsYou],
  [r8c, (s) => s.parent === r8 && s.current === "ci"],
  [r9, (s) => Boolean(s.child)],
  [r10, (s) => s.current === "inner" && s.needsYou && !s.child],
];
let bad = 0;
for (const [id, ok] of expected) {
  const s = f.runSummary(f.store.getRun(id)!);
  const pass = ok(s);
  if (!pass) bad++;
  console.log(`${pass ? "ok  " : "FAIL"} ${id.padEnd(16)} ${s.status.padEnd(12)} ${s.current ?? "-"}`);
}
if (bad) {
  console.error(`${bad} preview state(s) not reached`);
  process.exit(1);
}
console.log(`flows UI preview: ${base}  (home ${home}; Ctrl-C to stop)`);
