import { test } from "node:test";
import assert from "node:assert/strict";
import { checksOutcome, pollOnce, makeGhPlugin, type Exec } from "../plugins/gh.ts";
import type { PluginCtx, PluginEvent } from "../src/plugins.ts";

const fake = (answers: Record<string, { code?: number; stdout?: string; stderr?: string }>): Exec & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => {
    calls.push(args);
    const a = answers[args.slice(0, 2).join(" ")] ?? {};
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  }) as Exec & { calls: string[][] };
  fn.calls = calls;
  return fn;
};

test("checksOutcome: pending → null, green → done, red/cancelled → failed with names", () => {
  assert.equal(checksOutcome([{ name: "a", bucket: "pass" }, { name: "b", bucket: "pending" }]), null);
  assert.deepEqual(checksOutcome([{ name: "a", bucket: "pass" }, { name: "s", bucket: "skipping" }]), { outcome: "done", data: { failed: [], links: [] } });
  assert.deepEqual(checksOutcome([{ name: "a", bucket: "fail", link: "u1" }, { name: "b", bucket: "cancel", link: "u2" }, { name: "c", bucket: "pass" }]),
    { outcome: "failed", data: { failed: ["a", "b"], links: ["u1", "u2"] } });
  assert.deepEqual(checksOutcome([]), { outcome: "done", data: { failed: [], links: [] } });
});

test("pollOnce checks parses stdout even on a non-zero exit, and treats no required checks as green", async () => {
  const red = fake({ "pr checks": { code: 1, stdout: JSON.stringify([{ name: "lint", bucket: "fail", link: "L" }]) } });
  assert.deepEqual(await pollOnce("checks", "https://x/pull/7", red), { emit: { outcome: "failed", data: { failed: ["lint"], links: ["L"] } } });
  assert.deepEqual(red.calls[0], ["pr", "checks", "https://x/pull/7", "--required", "--json", "name,bucket,link"]);
  const none = fake({ "pr checks": { code: 1, stderr: "no required checks reported on the 'x' branch" } });
  assert.deepEqual(await pollOnce("checks", "7", none), { emit: { outcome: "done", data: { failed: [], links: [] } } });
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
  const stop = makeGhPlugin(exec).watch!({ run: "p#1", entry: "merge", type: "gh.merged", with: {}, vars: { pr: "7" } }, ctx) as () => void;
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.deepEqual(emitted, [{ type: "gh.merged", run: "p#1", entry: "merge", outcome: "done", data: { pr: "7", state: "MERGED" } }]);
  assert.deepEqual(errors, []);
});

test("the plugin refuses a watch without a PR", () => {
  const ctx: PluginCtx = { emit: () => {}, log: () => {}, error: () => {}, config: {} };
  assert.throws(() => makeGhPlugin(fake({})).watch!({ run: "p#1", entry: "ci", type: "gh.checks", with: {}, vars: {} }, ctx), /no pr/);
});
