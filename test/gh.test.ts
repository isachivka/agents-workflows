import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_POLLS, checksOutcome, countedItems, parseReviewAnswer, pollOnce, pollRepo, reviewOutcome, makeGhPlugin, type Exec } from "../plugins/gh.ts";
import type { PluginCtx, PluginEvent } from "../src/plugins.ts";

const fake = (answers: Record<string, { code?: number; stdout?: string; stderr?: string }>): Exec & { calls: string[][]; cwds: (string | undefined)[] } => {
  const calls: string[][] = [];
  const cwds: (string | undefined)[] = [];
  const fn = (async (args: string[], cwd?: string) => {
    calls.push(args);
    cwds.push(cwd);
    const a = answers[args.slice(0, 2).join(" ")] ?? {};
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  }) as Exec & { calls: string[][]; cwds: (string | undefined)[] };
  fn.calls = calls;
  fn.cwds = cwds;
  return fn;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("checksOutcome: pending → null, green → done, red/cancelled → failed with names", () => {
  assert.equal(checksOutcome([{ name: "a", bucket: "pass" }, { name: "b", bucket: "pending" }]), null);
  assert.deepEqual(checksOutcome([{ name: "a", bucket: "pass" }, { name: "s", bucket: "skipping" }]), { outcome: "done", data: { failed: [], links: [] } });
  assert.deepEqual(checksOutcome([{ name: "a", bucket: "fail", link: "u1" }, { name: "b", bucket: "cancel", link: "u2" }, { name: "c", bucket: "pass" }]),
    { outcome: "failed", data: { failed: ["a", "b"], links: ["u1", "u2"] } });
  assert.deepEqual(checksOutcome([]), { outcome: "done", data: { failed: [], links: [] } });
});

test("pollOnce checks parses stdout even on a non-zero exit; no checks turn green only once they stay absent", async () => {
  const red = fake({ "pr checks": { code: 1, stdout: JSON.stringify([{ name: "lint", bucket: "fail", link: "L" }]) } });
  assert.deepEqual(await pollOnce("checks", "https://x/pull/7", red), { emit: { outcome: "failed", data: { failed: ["lint"], links: ["L"] } } });
  assert.deepEqual(red.calls[0], ["pr", "checks", "https://x/pull/7", "--required", "--json", "name,bucket,link"]);
  const none = fake({ "pr checks": { code: 1, stderr: "no required checks reported on the 'x' branch" } });
  // right after the PR opens CI has not registered its checks yet: that is pending, not green
  assert.deepEqual(await pollOnce("checks", "7", none), { baseline: "1" });
  assert.deepEqual(await pollOnce("checks", "7", fake({ "pr checks": { stdout: "[]" } }), "1"), { baseline: "2" });
  assert.deepEqual(await pollOnce("checks", "7", none, String(EMPTY_POLLS - 1)), { emit: { outcome: "done", data: { failed: [], links: [] } } });
  // checks seen pending restart the count: empty polls must be in a row
  const pending = fake({ "pr checks": { code: 8, stdout: JSON.stringify([{ name: "ci", bucket: "pending" }]) } });
  assert.deepEqual(await pollOnce("checks", "7", pending, String(EMPTY_POLLS - 1)), { baseline: "0" });
  const broken = fake({ "pr checks": { code: 4, stderr: "HTTP 401" } });
  await assert.rejects(pollOnce("checks", "7", broken), /HTTP 401/);
});

test("pollOnce merged: open → nothing, merged → done, closed → failed", async () => {
  const st = (state: string) => fake({ "pr view": { stdout: JSON.stringify({ state }) } });
  assert.deepEqual(await pollOnce("merged", "7", st("OPEN")), {});
  assert.deepEqual(await pollOnce("merged", "7", st("MERGED")), { emit: { outcome: "done", data: { state: "MERGED" } } });
  assert.deepEqual(await pollOnce("merged", "7", st("CLOSED")), { emit: { outcome: "failed", data: { state: "CLOSED" } } });
});

test("pollOnce review: the first poll sets the baseline, a change emits", async () => {
  const v = (r: number, c: number) => fake({ "pr view": { stdout: JSON.stringify({ reviews: Array(r).fill({}), comments: Array(c).fill({}) }) } });
  assert.deepEqual(await pollOnce("review", "7", v(1, 2)), { baseline: "1/2" });
  assert.deepEqual(await pollOnce("review", "7", v(1, 2), "1/2"), { baseline: "1/2" });
  assert.deepEqual(await pollOnce("review", "7", v(1, 3), "1/2"), { baseline: "1/3", emit: { data: { reviews: 1, comments: 3 } } });
});

test("the plugin polls the watched PR and emits once, targeted at the waiting entry", async () => {
  const exec = fake({ "pr view": { stdout: JSON.stringify({ state: "MERGED" }) } });
  const emitted: PluginEvent[] = [];
  const errors: string[] = [];
  const ctx: PluginCtx = { emit: (e) => emitted.push(e), log: () => {}, error: (e) => errors.push(String(e)), config: { interval_ms: 5 } };
  const stop = makeGhPlugin(exec).watch!({ run: "p#1", entry: "merge", type: "gh.merged", with: {}, cwd: "/w", vars: { pr: "7" } }, ctx) as () => void;
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.deepEqual(emitted, [{ type: "gh.merged", run: "p#1", entry: "merge", outcome: "done", data: { pr: "7", state: "MERGED" } }]);
  assert.deepEqual(errors, []);
});

test("the plugin refuses a gh.checks wait without a PR", () => {
  const ctx: PluginCtx = { emit: () => {}, log: () => {}, error: () => {}, config: {} };
  assert.throws(() => makeGhPlugin(fake({})).watch!({ run: "p#1", entry: "ci", type: "gh.checks", with: {}, cwd: "/w", vars: {} }, ctx), /gh\.checks needs a PR/);
});

const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T00:00:00Z`;
const PR = (n: number, extra = {}) => ({ number: n, url: `https://g/pull/${n}`, title: `t${n}`, headRefName: `b${n}`, baseRefName: "main", author: { login: "me" }, labels: [], createdAt: day(n), mergedAt: day(n), ...extra });

test("pollRepo merged/opened: pr list with filters, documented data", async () => {
  const exec = fake({ "pr list": { stdout: JSON.stringify([PR(2), PR(1)]) } });
  const items = await pollRepo("merged", { with: { base: "main", label: "x", repo: "o/r" }, cwd: "/w" }, exec);
  assert.deepEqual(exec.calls[0], ["pr", "list", "--repo", "o/r", "--state", "merged", "--search", "sort:updated-desc", "--limit", "30", "--json", "number,url,title,headRefName,baseRefName,author,labels,createdAt,mergedAt", "--base", "main", "--label", "x"]);
  assert.deepEqual(items[1], { id: "1", at: day(1), outcome: "done", data: { pr: "https://g/pull/1", number: 1, title: "t1", branch: "b1", base: "main", author: "me" } });
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
  assert.throws(() => makeGhPlugin(fake({})).watch!({ type: "gh.review", with: {}, cwd: "/w", vars: {} }, ctx), /gh\.review needs a PR/);
  assert.throws(() => makeGhPlugin(fake({})).watch!({ type: "gh.ci", with: {}, cwd: "/w", vars: {} }, ctx), /gh\.ci needs with\.branch/);
});

test("gh runs in the watch's cwd, in repo and PR mode", async () => {
  const exec = fake({ "pr list": { stdout: "[]" }, "pr view": { stdout: JSON.stringify({ state: "OPEN" }) } });
  await pollRepo("merged", { with: {}, cwd: "/w" }, exec);
  await pollOnce("merged", "7", exec, undefined, "/w2");
  assert.deepEqual(exec.cwds, ["/w", "/w2"]);
});

const repoCtx = (emitted: PluginEvent[], errors: unknown[] = []): PluginCtx =>
  ({ emit: (e) => emitted.push(e), log: () => {}, error: (e) => errors.push(e), config: { interval_ms: 5 } });

test("an old open PR that slides into the window does not fire gh.opened", async () => {
  let list = [40, 39, 38].map((n) => PR(n));
  const exec = (async () => ({ code: 0, stdout: JSON.stringify(list), stderr: "" })) as Exec;
  const emitted: PluginEvent[] = [];
  const stop = makeGhPlugin(exec).watch!({ type: "gh.opened", with: {}, cwd: "/w", vars: {} }, repoCtx(emitted)) as () => void;
  await sleep(15);
  list = [40, 38, 10].map((n) => PR(n)); // #39 closed, an old PR enters the window
  await sleep(15);
  stop();
  assert.deepEqual(emitted, []);
});

test("gh.merged fires for a long-lived PR merged now, not for an old merge that was only touched", async () => {
  let list = [PR(5)];
  const exec = (async () => ({ code: 0, stdout: JSON.stringify(list), stderr: "" })) as Exec;
  const emitted: PluginEvent[] = [];
  const stop = makeGhPlugin(exec).watch!({ type: "gh.merged", with: {}, cwd: "/w", vars: {} }, repoCtx(emitted)) as () => void;
  await sleep(15);
  list = [PR(2, { mergedAt: day(9) }), PR(1, { mergedAt: day(3) }), PR(5)]; // #2: opened long ago, merged now; #1: old merge, commented on
  await sleep(15);
  stop();
  assert.deepEqual(emitted.map((e) => e.data!.number), [2]);
});

test("a gh.merged wait without a PR or a repo filter refuses instead of waiting for any merge", () => {
  const ctx = repoCtx([]);
  assert.throws(() => makeGhPlugin(fake({})).watch!({ type: "gh.merged", run: "p#1", entry: "m", with: {}, cwd: "/w", vars: {} }, ctx), /gh\.merged needs a PR/);
  assert.doesNotThrow(() => (makeGhPlugin(fake({ "pr list": { stdout: "[]" } })).watch!({ type: "gh.merged", run: "p#1", entry: "m", with: { base: "main" }, cwd: "/w", vars: {} }, ctx) as () => void)());
});

test("a trigger cannot watch one PR: it watches a repo", () => {
  assert.throws(() => makeGhPlugin(fake({})).watch!({ type: "gh.merged", with: { pr: "7" }, cwd: "/w", vars: {} }, repoCtx([])), /a trigger watches a repo/);
});

test("a poll that works again clears the error the last one reported", async () => {
  let fail = true;
  const exec = (async () => (fail ? { code: 1, stdout: "", stderr: "network down" } : { code: 0, stdout: "[]", stderr: "" })) as Exec;
  const errors: unknown[] = [];
  const stop = makeGhPlugin(exec).watch!({ type: "gh.merged", with: {}, cwd: "/w", vars: {} }, repoCtx([], errors)) as () => void;
  await sleep(8);
  fail = false;
  await sleep(15);
  stop();
  assert.match(String(errors[0]), /network down/);
  assert.equal(errors[errors.length - 1], null);
});

// --- gh.review from the reviewer: recorded GraphQL answers ---

type Rv = { id: string; by: string; bot?: boolean; state: string; at: string };
type Cm = { id: string; by: string; bot?: boolean; at: string };
const answer = (o: { state?: string; author?: string; decision?: string | null; requested?: (string | { team: string } | { bot: string } | null)[]; reviews?: Rv[]; comments?: Cm[]; totals?: [number, number]; errors?: string[] }) => ({
  ...(o.errors ? { errors: o.errors.map((message) => ({ message })) } : {}),
  data: { repository: { pullRequest: {
    state: o.state ?? "OPEN",
    author: { login: o.author ?? "carol" },
    reviewDecision: o.decision ?? null,
    timelineItems: { nodes: (o.requested ?? []).map((r) => ({ requestedReviewer:
      r === null ? null : typeof r === "string" ? { __typename: "User", login: r } : "team" in r ? { __typename: "Team", slug: r.team } : { __typename: "Bot", login: r.bot } })) },
    reviews: { totalCount: o.totals?.[0] ?? (o.reviews ?? []).length, nodes: (o.reviews ?? []).map((r) => ({ id: r.id, url: `https://g/pull/7#${r.id}`, state: r.state, submittedAt: r.at, author: { __typename: r.bot ? "Bot" : "User", login: r.by } })) },
    comments: { totalCount: o.totals?.[1] ?? (o.comments ?? []).length, nodes: (o.comments ?? []).map((c) => ({ id: c.id, url: `https://g/pull/7#${c.id}`, createdAt: c.at, author: { __typename: c.bot ? "Bot" : "User", login: c.by } })) },
  } } },
});
const PRURL = "https://github.com/org/app/pull/7";

test("parseReviewAnswer: requested users from the timeline, never teams or bots", () => {
  const a = parseReviewAnswer(answer({ requested: [{ team: "frontend-team" }, "alice", { bot: "ci-bot" }, null, "bob"], reviews: [{ id: "R1", by: "ci-bot", bot: true, state: "COMMENTED", at: day(1) }] }));
  assert.deepEqual(a.requested, ["alice", "bob"]);
  assert.equal(a.author.login, "carol");
  assert.deepEqual(a.items[0], { id: "R1", kind: "review", by: "ci-bot", bot: true, state: "COMMENTED", at: day(1), url: "https://g/pull/7#R1" });
  assert.throws(() => parseReviewAnswer({ errors: [{ message: "Could not resolve to a PullRequest" }] }), /Could not resolve/);
  // partial data (say a team the token cannot read) is still an answer
  assert.deepEqual(parseReviewAnswer(answer({ requested: ["alice"], errors: ["Resource not accessible by integration"] })).requested, ["alice"]);
});

test("countedItems: requested people only, never bots or the author; decisions only on request; oldest first", () => {
  const a = parseReviewAnswer(answer({
    requested: ["alice", { team: "frontend-team" }],
    reviews: [
      { id: "R3", by: "alice", state: "APPROVED", at: day(3) },
      { id: "R1", by: "ci-bot", bot: true, state: "COMMENTED", at: day(1) },
      { id: "R2", by: "alice", state: "COMMENTED", at: day(2) },
      { id: "R4", by: "dave", state: "APPROVED", at: day(4) },
    ],
    comments: [{ id: "C1", by: "carol", at: day(1) }, { id: "C2", by: "alice", at: day(2) }],
  }));
  assert.deepEqual(countedItems(a, { from: "requested" }).map((i) => i.id), ["R2", "C2", "R3"]);
  assert.deepEqual(countedItems(a, { from: "requested", only: "decisions" }).map((i) => i.id), ["R3"]);
  assert.deepEqual(countedItems(a, { from: "alice, dave", only: "decisions" }).map((i) => i.id), ["R3", "R4"]);
  assert.deepEqual(countedItems(a, { from: "carol" }), [], "the PR's author never counts");
});

test("reviewOutcome: approved is done, changes requested is failed, anything else none", () => {
  assert.deepEqual(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", ""].map(reviewOutcome), ["done", "failed", undefined, undefined]);
});

/** A fake gh that answers the review query with whatever `state.now` holds. */
const reviewExec = (state: { now: unknown }) => {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(state.now), stderr: "" };
  }) as Exec & { calls: string[][] };
  fn.calls = calls;
  return fn;
};
const reviewWait = (withArgs: Record<string, unknown>, previous?: { type: string; data: Record<string, unknown> }) =>
  ({ type: "gh.review", run: "p#1", entry: "feedback", with: withArgs, cwd: "/w", vars: { pr: PRURL }, ...(previous ? { previous } : {}) });

test("a from wait asks GraphQL for the PR, baselines, then emits the requested reviewer's next review with its outcome", async () => {
  const state = { now: answer({ requested: ["alice"], reviews: [{ id: "R1", by: "alice", state: "COMMENTED", at: day(1) }] }) as unknown };
  const exec = reviewExec(state);
  const emitted: PluginEvent[] = [];
  const stop = makeGhPlugin(exec).watch!(reviewWait({ from: "requested" }), repoCtx(emitted)) as () => void;
  await sleep(12);
  state.now = answer({ decision: "CHANGES_REQUESTED", requested: ["alice"], reviews: [
    { id: "R1", by: "alice", state: "COMMENTED", at: day(1) },
    { id: "R2", by: "ci-bot", bot: true, state: "COMMENTED", at: day(2) },
    { id: "R3", by: "alice", state: "CHANGES_REQUESTED", at: day(3) },
  ] });
  await sleep(20);
  stop();
  const args = exec.calls[0];
  assert.deepEqual([args[0], args[1]], ["api", "graphql"]);
  assert.ok(args.includes("owner=org") && args.includes("name=app") && args.includes("number=7"), args.join(" "));
  assert.deepEqual(emitted, [{ type: "gh.review", run: "p#1", entry: "feedback", outcome: "failed", data: {
    pr: PRURL, id: "R3", by: "alice", kind: "review", state: "CHANGES_REQUESTED", decision: "CHANGES_REQUESTED", url: "https://g/pull/7#R3", at: day(3), reviews: 3, comments: 0,
  } }]);
});

test("a reviewer who already reviewed and left the current requests still counts; one assigned after arming does too", async () => {
  const state = { now: answer({ requested: [{ team: "frontend-team" }, "alice"], reviews: [{ id: "R1", by: "alice", state: "APPROVED", at: day(1) }] }) as unknown };
  const emitted: PluginEvent[] = [];
  const stop = makeGhPlugin(reviewExec(state)).watch!(reviewWait({ from: "requested" }), repoCtx(emitted)) as () => void;
  await sleep(12);
  state.now = answer({ requested: [{ team: "frontend-team" }, "alice", "bob"], reviews: [
    { id: "R1", by: "alice", state: "APPROVED", at: day(1) },
    { id: "R2", by: "bob", state: "COMMENTED", at: day(2) },
  ] });
  await sleep(20);
  stop();
  assert.deepEqual(emitted.map((e) => e.data!.by), ["bob"]);
});

test("only decisions: a comment does not wake a pure wait", async () => {
  const state = { now: answer({ requested: ["alice"] }) as unknown };
  const emitted: PluginEvent[] = [];
  const stop = makeGhPlugin(reviewExec(state)).watch!(reviewWait({ from: "requested", only: "decisions" }), repoCtx(emitted)) as () => void;
  await sleep(12);
  state.now = answer({ requested: ["alice"], comments: [{ id: "C1", by: "alice", at: day(2) }], reviews: [{ id: "R1", by: "alice", state: "COMMENTED", at: day(2) }] });
  await sleep(20);
  stop();
  assert.deepEqual(emitted, []);
});

test("already fires at once on an existing decision, but not on the one that already woke the entry", async () => {
  const existing = answer({ decision: "CHANGES_REQUESTED", requested: ["alice"], reviews: [{ id: "R1", by: "alice", state: "CHANGES_REQUESTED", at: day(1) }] });
  const fresh: PluginEvent[] = [];
  const stopFresh = makeGhPlugin(reviewExec({ now: existing })).watch!(reviewWait({ from: "requested", already: true }), repoCtx(fresh)) as () => void;
  await sleep(10);
  stopFresh();
  assert.deepEqual(fresh.map((e) => [e.data!.id, e.outcome]), [["R1", "failed"]]);
  // the retry loop: the agent fixed, failed with "waiting for re-review", the wait is re-armed
  const state = { now: existing as unknown };
  const again: PluginEvent[] = [];
  const stop = makeGhPlugin(reviewExec(state)).watch!(reviewWait({ from: "requested", already: true }, { type: "gh.review", data: { id: "R1" } }), repoCtx(again)) as () => void;
  try {
    await sleep(12);
    assert.equal(again.length, 0);
    state.now = answer({ decision: "APPROVED", requested: ["alice"], reviews: [
      { id: "R1", by: "alice", state: "CHANGES_REQUESTED", at: day(1) },
      { id: "R2", by: "alice", state: "APPROVED", at: day(2) },
    ] });
    await sleep(20);
  } finally {
    stop();
  }
  assert.deepEqual(again.map((e) => [e.data!.id, e.outcome]), [["R2", "done"]]);
});

test("gh.review refuses an unknown only, and a bare PR number without with.repo", () => {
  const ctx = repoCtx([]);
  assert.throws(() => makeGhPlugin(fake({})).watch!(reviewWait({ from: "requested", only: "approvals" }), ctx), /gh\.review: only must be "decisions"/);
  assert.throws(() => makeGhPlugin(fake({})).watch!({ ...reviewWait({ from: "alice" }), vars: { pr: "7" } }, ctx), /with\.repo/);
});

const runWatch = async (state: { now: unknown }, withArgs: Record<string, unknown>, change: () => void, previous?: { type: string; data: Record<string, unknown> }) => {
  const emitted: PluginEvent[] = [];
  const stop = makeGhPlugin(reviewExec(state)).watch!(reviewWait(withArgs, previous), repoCtx(emitted)) as () => void;
  try {
    await sleep(12);
    change();
    await sleep(20);
  } finally {
    stop();
  }
  return emitted;
};

test("already does not re-fire an old decision after a comment woke the entry", async () => {
  const state = { now: answer({ requested: ["alice"], reviews: [{ id: "R1", by: "alice", state: "CHANGES_REQUESTED", at: day(1) }], comments: [{ id: "C1", by: "alice", at: day(2) }] }) as unknown };
  const emitted = await runWatch(state, { from: "requested", already: true }, () => {}, { type: "gh.review", data: { id: "C1", at: day(2) } });
  assert.deepEqual(emitted, []);
});

test("from matches logins whatever their case; an empty from is refused", async () => {
  const state = { now: answer({ requested: [] }) as unknown };
  const emitted = await runWatch(state, { from: "Alice" }, () => { state.now = answer({ reviews: [{ id: "R1", by: "alice", state: "APPROVED", at: day(2) }] }); });
  assert.deepEqual(emitted.map((e) => e.data!.by), ["alice"]);
  assert.throws(() => makeGhPlugin(fake({})).watch!(reviewWait({ from: " , " }), repoCtx([])), /gh\.review: from needs/);
});

test("an old comment that slides back into the 50-item window is not taken for new", async () => {
  const c = (n: number) => ({ id: `C${n}`, by: "alice", at: day(n + 1) });
  const state = { now: answer({ requested: ["alice"], comments: Array.from({ length: 5 }, (_, k) => c(k + 1)) }) as unknown };
  const emitted = await runWatch(state, { from: "requested" }, () => { state.now = answer({ requested: ["alice"], comments: [c(0), c(1), c(2), c(3), c(4)] }); });
  assert.deepEqual(emitted, []);
});

test("owner and repository names go to GraphQL as strings, the number as a number", async () => {
  const exec = reviewExec({ now: answer({}) });
  const stop = makeGhPlugin(exec).watch!({ ...reviewWait({ from: "alice" }), vars: { pr: "https://github.com/org/2048/pull/7" } }, repoCtx([])) as () => void;
  await sleep(5);
  stop();
  const a = exec.calls[0];
  assert.equal(a[a.indexOf("owner=org") - 1], "-f");
  assert.equal(a[a.indexOf("name=2048") - 1], "-f");
  assert.equal(a[a.indexOf("number=7") - 1], "-F");
});

test("review and comment counts in the event are the PR's totals, not the 50-item window", async () => {
  const state = { now: answer({ requested: ["alice"], totals: [120, 300] }) as unknown };
  const emitted = await runWatch(state, { from: "requested" }, () => {
    state.now = answer({ requested: ["alice"], reviews: [{ id: "R9", by: "alice", state: "APPROVED", at: day(9) }], totals: [121, 300] });
  });
  assert.deepEqual([emitted[0]?.data!.reviews, emitted[0]?.data!.comments], [121, 300]);
});

test("already: false keeps the plain count-based gh.review", () => {
  const exec = fake({ "pr view": { stdout: JSON.stringify({ reviews: [], comments: [] }) } });
  const stop = makeGhPlugin(exec).watch!({ ...reviewWait({ already: false }), vars: { pr: "7" } }, repoCtx([])) as () => void;
  stop();
  assert.deepEqual(exec.calls[0]?.slice(0, 2), ["pr", "view"]);
});

test("title reads the run's PR title; no pr, no call", async () => {
  const exec = fake({ "pr view": { stdout: JSON.stringify({ title: "Fix the login timeout" }) } });
  const gh = makeGhPlugin(exec);
  const ctx: PluginCtx = { emit: () => {}, log: () => {}, error: () => {}, config: {} };
  assert.equal(await gh.title!({ vars: { pr: "https://github.com/o/r/pull/7" }, cwd: "/w" }, ctx), "Fix the login timeout");
  assert.deepEqual([exec.calls[0], exec.cwds[0]], [["pr", "view", "https://github.com/o/r/pull/7", "--json", "title"], "/w"]);
  assert.equal(await gh.title!({ vars: {}, cwd: "/w" }, ctx), undefined);
  assert.equal(exec.calls.length, 1);
});

test("a review wait ends when the PR is merged (done) or closed (failed), even on the first poll", async () => {
  const state = { now: answer({ requested: ["alice"] }) as unknown };
  const emitted: PluginEvent[] = [];
  const stop = makeGhPlugin(reviewExec(state)).watch!(reviewWait({ from: "requested", already: true }), repoCtx(emitted)) as () => void;
  await sleep(12);
  state.now = answer({ state: "MERGED", decision: "REVIEW_REQUIRED", requested: ["alice"] });
  await sleep(20);
  stop();
  assert.deepEqual(emitted, [{ type: "gh.review", run: "p#1", entry: "feedback", outcome: "done", data: {
    pr: PRURL, id: "", by: "", kind: "merged", state: "MERGED", decision: "REVIEW_REQUIRED", url: PRURL, at: "", reviews: 0, comments: 0, merged: true } }]);
  const closed: PluginEvent[] = [];
  const stop2 = makeGhPlugin(reviewExec({ now: answer({ state: "CLOSED" }) })).watch!(reviewWait({ from: "requested" }), repoCtx(closed)) as () => void;
  await sleep(12);
  stop2();
  assert.deepEqual(closed.map((e) => [e.outcome, e.data!.merged]), [["failed", false]]);
});

test("pollOnce review: a merged or closed PR ends the wait at once", async () => {
  const v = (st: string) => fake({ "pr view": { stdout: JSON.stringify({ state: st, reviews: [], comments: [] }) } });
  assert.deepEqual(await pollOnce("review", "7", v("MERGED")), { emit: { outcome: "done", data: { state: "MERGED", merged: true, reviews: 0, comments: 0 } } });
  assert.deepEqual(await pollOnce("review", "7", v("CLOSED"), "0/0"), { emit: { outcome: "failed", data: { state: "CLOSED", merged: false, reviews: 0, comments: 0 } } });
  assert.deepEqual(await pollOnce("review", "7", v("OPEN")), { baseline: "0/0" });
});
