import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STEP_FILES, proc, settle } from "./daemon-helpers.ts";
import { serve } from "./http-helpers.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

/** Runs the CLI. AGTERM_SESSION_ID is always set explicitly: the test runner itself may live in an agterm session. */
function flow(args: string[], env: Record<string, string>) {
  const started = Date.now();
  return new Promise<{ code: number; stdout: string; stderr: string; ms: number }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, AGTERM_SESSION_ID: "", ...env } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

const TWO = proc("  - {step: b, role: pm}\n  - {step: c, role: pm}\n");

test("an agent session shows, sets, reports, and cannot report twice", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  await s.call("POST", "/api/runs", { process: "p" });
  await settle(s.f);
  const env = { FLOWD_URL: s.base, AGTERM_SESSION_ID: "S1" };
  const shown = await flow(["show"], env);
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /Do B for p#1/);
  const noNote = await flow(["failed"], env);
  assert.deepEqual([noNote.code, noNote.stderr], [1, "flow: flow failed needs --note saying what went wrong\n"]);
  const set = await flow(["set", "pr=https://x/pull/1"], env);
  assert.deepEqual([set.code, set.stderr], [0, ""]);
  assert.deepEqual(s.f.store.getRun("p#1")!.vars, { pr: "https://x/pull/1" });
  const other = await flow(["set", "pull_request=https://github.com/o/r/pull/7", "thread=https://chat.example/x/1"], env);
  assert.equal(other.code, 0);
  assert.equal(other.stderr, "flow: hint: pull_request looks like a pull request — the standard name is pr (flow set pr=https://github.com/o/r/pull/7)\n");
  const slack = await flow(["set", "thread=https://acme.slack.com/archives/C1/p2"], env);
  assert.equal(slack.stderr, "flow: hint: thread looks like a Slack thread — the standard name is slack_thread (flow set slack_thread=https://acme.slack.com/archives/C1/p2)\n");
  const done = await flow(["done", "--note", "ok"], env);
  assert.deepEqual([done.code, done.stdout], [0, "recorded done\n"]);
  const twice = await flow(["done"], env);
  assert.deepEqual([twice.code, twice.stderr], [1, "flow: step c has not reached the agent yet\n"]);
  await s.close();
});

test("from a plain terminal: start, ls, signal, human done", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO, ...proc("  - {id: w, wait_for: signal.go}\n  - {step: c, role: human}\n", "", "q") });
  const env = { FLOWD_URL: s.base };
  assert.deepEqual((await flow(["start", "q"], env)).stdout, "q#1\n");
  assert.match((await flow(["ls"], env)).stdout, /^q#1 {2}it\.1 {2}running {2}w \(waiting\) {2}waits signal\.go$/m);
  assert.equal((await flow(["signal", "go"], env)).stdout, "sent signal.go\n");
  await s.f.idle();
  assert.equal(s.f.store.getRun("q#1")!.current, "c");
  const noSession = await flow(["done"], env);
  assert.equal(noSession.code, 1);
  assert.match(noSession.stderr, /no session/);
  assert.equal((await flow(["done", "--human", "--run", "q#1", "--step", "c"], env)).code, 0);
  assert.equal(s.f.store.getRun("q#1")!.status, "done");
  await s.close();
});

test("usage errors and help", async () => {
  const env = { FLOWD_URL: "http://127.0.0.1:9" };
  assert.equal((await flow(["help"], env)).code, 0);
  const bad = await flow(["done", "--bogus"], env);
  assert.deepEqual([bad.code, bad.stderr], [1, "flow: unknown option --bogus\n"]);
  assert.equal((await flow(["set", "novalue"], env)).code, 1);
  assert.equal((await flow(["frobnicate"], env)).code, 1);
});

test("with flowd down, commands say so and hooks stay silent and fast", async () => {
  const down = { FLOWD_URL: "http://127.0.0.1:9" };
  const ls = await flow(["ls"], down);
  assert.equal(ls.code, 1);
  assert.match(ls.stderr, /^flow: flowd is not running: launchctl kickstart gui\/\d+\/local\.flows/);

  const sockets: Socket[] = [];
  const hang = createServer((sock) => { sockets.push(sock); }); // accepts and never answers
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const hung = { FLOWD_URL: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`, AGT_EVENT_KIND: "status", AGT_EVENT_STATUS: "idle", AGT_SESSION_ID: "S1" };
  for (const args of [["agterm-hook"], ["claude-hook", "compacted"]]) {
    const r = await flow(args, hung);
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
    assert.ok(r.ms < 3_500, `${args[0]} took ${r.ms} ms`);
  }
  for (const s of sockets) s.destroy();
  hang.close();
});

test("an agent waits on purpose: flow wait needs a note, and show and ls tell what it waits for", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  await s.call("POST", "/api/runs", { process: "p" });
  await settle(s.f);
  const env = { FLOWD_URL: s.base, AGTERM_SESSION_ID: "S1" };
  const noNote = await flow(["wait"], env);
  assert.deepEqual([noNote.code, noNote.stderr], [1, "flow: flow wait needs --note saying what you are waiting for\n"]);
  const waited = await flow(["wait", "--note", "review running"], env);
  assert.deepEqual([waited.code, waited.stdout], [0, "waiting: review running\n"]);
  const shown = (await flow(["show"], env)).stdout;
  assert.match(shown, /^waiting since .*: review running$/m);
  assert.match(shown, /`flow wait --note …`/);
  assert.match((await flow(["ls"], { FLOWD_URL: s.base })).stdout, /b \(active, waiting: review running\)/);
  await s.close();
});

test("flow ls --process and --where find runs by a variable; no match exits 1", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO, ...proc("  - {id: w, wait_for: signal.go}\n", "", "q") });
  const env = { FLOWD_URL: s.base };
  await flow(["start", "p"], env);
  await flow(["start", "q"], env);
  await settle(s.f);
  await flow(["set", "pr=https://github.com/o/r/pull/7", "--run", "p#1"], env);
  await flow(["set", "pr=https://github.com/o/r/pull/7", "--run", "q#1"], env);
  const hit = await flow(["ls", "--all", "--process", "p", "--where", "pr=https://github.com/o/r/pull/7"], env);
  assert.equal(hit.code, 0);
  assert.match(hit.stdout, /^p#1 /);
  assert.doesNotMatch(hit.stdout, /q#1/);
  const miss = await flow(["ls", "--all", "--where", "pr=https://github.com/o/r/pull/8"], env);
  assert.deepEqual([miss.code, miss.stdout], [1, "no runs\n"]);
  assert.equal((await flow(["ls", "--all", "--process", "nope"], env)).code, 1);
  await s.close();
});

test("after its flow failed stopped the run, the agent finishes the step once the user steered it", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  await s.call("POST", "/api/runs", { process: "p" });
  await settle(s.f);
  const env = { FLOWD_URL: s.base, AGTERM_SESSION_ID: "S1" };
  assert.equal((await flow(["failed", "--note", "red"], env)).code, 0);
  assert.equal(s.f.store.getRun("p#1")!.status, "needs-human");
  assert.equal((await flow(["done", "--note", "fixed the way the user asked: green"], env)).code, 0);
  await settle(s.f);
  const run = s.f.store.getRun("p#1")!;
  assert.deepEqual([run.status, run.current], ["running", "c"]);
  await s.close();
});

test("flow start --var seeds the run's vars before its first step renders", async () => {
  const s = await serve({ ...STEP_FILES, ...proc("  - {step: b, role: pm}\n", "", "q") });
  const env = { FLOWD_URL: s.base };
  const started = await flow(["start", "q", "--var", "title=Fix the login timeout", "--var", "query=a=b c"], env);
  assert.deepEqual([started.code, started.stdout], [0, "q#1\n"]);
  await settle(s.f);
  assert.deepEqual(s.f.store.getRun("q#1")!.vars, { title: "Fix the login timeout", query: "a=b c" });
  const bad = await flow(["start", "q", "--var", "novalue"], env);
  assert.deepEqual([bad.code, bad.stderr], [1, "flow: expected key=value, got novalue\n"]);
  await s.close();
});
