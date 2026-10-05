import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_POLLS, checksOutcome, pollOnce, pollRepo, makeGhPlugin, type Exec } from "../plugins/gh.ts";
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
  assert.throws(() => makeGhPlugin(fake({})).watch!({ type: "gh.review", with: {}, cwd: "/w", vars: {} }, ctx), /gh\.review needs a PR/);
  assert.throws(() => makeGhPlugin(fake({})).watch!({ type: "gh.ci", with: {}, cwd: "/w", vars: {} }, ctx), /gh\.ci needs with\.branch/);
});

test("gh runs in the watch's cwd, in repo and PR mode", async () => {
  const exec = fake({ "pr list": { stdout: "[]" }, "pr view": { stdout: JSON.stringify({ state: "OPEN" }) } });
  await pollRepo("merged", { with: {}, cwd: "/w" }, exec);
  await pollOnce("merged", "7", exec, undefined, "/w2");
  assert.deepEqual(exec.cwds, ["/w", "/w2"]);
});
