import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { CHAT_ON, STEP_FILES, chatCtx, chatLog, makeHome, proc, resetChat, settle, startFlowd } from "./daemon-helpers.ts";

const TWO = proc("  - {step: b, role: pm}\n  - {step: c, role: pm}\n");
const OUTER = proc("  - {step: b, role: pm}\n  - {inner: true, role: pm}\n  - {step: c, role: pm}\n", "", "outer");
const LEAF = proc("  - {step: b, role: pm}\n", "", "leaf");

const start = (process: string, bind: Record<string, string>, extra: Record<string, unknown> = {}) =>
  ({ type: "run.start", data: { process, bind, ...extra }, source: "test" });
const status = (session: string, s: string) => ({ type: "agterm.status", data: { session, status: s }, source: "agterm" });
const done = (session: string) => ({ type: "entry.report", data: { session, outcome: "done" }, source: "cli" });

async function running(files: Record<string, string> = {}) {
  resetChat();
  const home = makeHome({ ...STEP_FILES, ...TWO, ...CHAT_ON, ...files });
  const t = await startFlowd(home);
  t.agterm.addSession("S1");
  await t.f.submit(start("p", { pm: "S1" }, { vars: { title: "Fix the thing" } }));
  await settle(t.f);
  return { ...t, home };
}

test("flow say opens the run's conversation once and posts into it", async () => {
  const { f, home } = await running();
  const file = join(home, "report.html");
  writeFileSync(file, "<p>hi</p>");
  const [a, b] = await Promise.all([f.say({ session: "S1", text: "one" }), f.say({ session: "S1", text: "two", file })]);
  assert.deepEqual([a, b], [{}, {}]);
  assert.deepEqual(chatLog(), ["open p#1 Fix the thing", "post T1 one", `post T1 two +${file}`]);
  assert.deepEqual(f.store.chatOf("p#1"), { adapter: "fakechat", address: "T1" });
  assert.deepEqual(await f.say({ run: "p#1", text: "three" }), {});
  assert.equal(chatLog().at(-1), "post T1 three");
  await f.close();
});

test("a nested run talks in its root run's conversation", async () => {
  resetChat();
  const t = await startFlowd(makeHome({ ...STEP_FILES, ...OUTER, ...LEAF, ...CHAT_ON }));
  t.agterm.addSession("S1");
  await t.f.submit(start("outer", { pm: "S1" }, { inner: ["leaf"] }));
  await settle(t.f);
  await t.f.submit(status("S1", "active"));
  await t.f.submit(done("S1"));
  await settle(t.f);
  assert.equal(t.f.store.runBySession("S1")?.run.id, "leaf#1");
  assert.deepEqual(await t.f.say({ session: "S1", text: "from the leaf" }), {});
  assert.deepEqual(chatLog(), ["open outer#1 ", "post T1 from the leaf"]);
  assert.equal(t.f.store.chatOf("leaf#1"), null);
  await t.f.close();
});

test("flow say is refused without a messenger, without a run, with a missing file; a failing post comes back", async () => {
  resetChat();
  const off = await startFlowd(makeHome({ ...STEP_FILES, ...TWO }));
  assert.deepEqual(await off.f.say({ run: "p#1", text: "x" }), { error: "no chat is set up: add a telegram section to $FLOWS_HOME/plugins.yaml (docs/plugins.md)" });
  await off.f.close();

  const { f, home } = await running();
  assert.deepEqual(await f.say({ session: "S9", text: "x" }), { error: "no open run is bound to this session" });
  assert.deepEqual(await f.say({ run: "p#9", text: "x" }), { error: "no run p#9" });
  assert.deepEqual(await f.say({ session: "S1", text: "x", file: join(home, "nope.html") }), { error: `no file ${join(home, "nope.html")}` });
  assert.deepEqual(chatLog(), []);
  resetChat(true);
  assert.deepEqual(await f.say({ session: "S1", text: "x" }), { error: "fakechat: no rights" });
  assert.equal(f.plugins.status().find((p) => p.name === "fakechat")?.lastError, "no rights");
  await f.close();
});

test("an address another messenger opened is not reused", async () => {
  const { f } = await running();
  f.store.setChat("p#1", "slack", "C1/1.2");
  assert.deepEqual(await f.say({ session: "S1", text: "x" }), {});
  assert.deepEqual(chatLog(), ["open p#1 Fix the thing", "post T1 x"]);
  assert.deepEqual(f.store.chatOf("p#1"), { adapter: "fakechat", address: "T1" });
  await f.close();
});

const HUMAN = proc("  - {step: b, role: pm}\n  - {step: c, role: human}\n", "", "h");

/** The agent does its current step and ends its turn; the next line goes out after the gap. */
async function finishB(t: Awaited<ReturnType<typeof startFlowd>>) {
  await t.f.submit(status("S1", "active"));
  await t.f.submit(done("S1"));
  await t.f.submit(status("S1", "completed"));
  t.clock.t += 17_000;
  await settle(t.f);
}

test("a run that comes to need the person says so, opening its conversation; once, not again while it waits", async () => {
  resetChat();
  const t = await startFlowd(makeHome({ ...STEP_FILES, ...HUMAN, ...CHAT_ON }));
  t.agterm.addSession("S1");
  await t.f.submit(start("h", { pm: "S1" }));
  await settle(t.f);
  await finishB(t);
  assert.deepEqual(chatLog(), ["open h#1 ", "post T1 h#1 waits for you: c"]);
  await t.f.submit({ type: "run.set", run: "h#1", data: { vars: { x: "1" } }, source: "cli" });
  await settle(t.f);
  assert.equal(chatLog().length, 2);
  await t.f.close();
});

test("flow wait --human says what the agent waits for", async () => {
  const t = await running();
  await t.f.submit(status("S1", "active"));
  await t.f.submit({ type: "entry.wait", data: { session: "S1", note: "plan waits for your OK", human: true }, source: "cli" });
  await settle(t.f);
  assert.deepEqual(chatLog(), ["open p#1 Fix the thing", "post T1 p#1 waits for you: plan waits for your OK"]);
  await t.f.close();
});

test("the end of a run with a conversation is said there and closes it; a run without one opens none", async () => {
  const t = await running();
  await t.f.say({ session: "S1", text: "hi" });
  await finishB(t);
  await finishB(t);
  assert.equal(t.f.store.getRun("p#1")?.status, "done");
  assert.deepEqual(chatLog(), ["open p#1 Fix the thing", "post T1 hi", "post T1 p#1 is done", "close T1 done"]);
  await t.f.close();

  const quiet = await running();
  await finishB(quiet);
  await finishB(quiet);
  assert.equal(quiet.f.store.getRun("p#1")?.status, "done");
  assert.deepEqual(chatLog(), []);
  await quiet.f.close();
});

test("a messenger that fails leaves the run as it was and shows the error on the plugin", async () => {
  resetChat(true);
  const t = await startFlowd(makeHome({ ...STEP_FILES, ...HUMAN, ...CHAT_ON }));
  t.agterm.addSession("S1");
  await t.f.submit(start("h", { pm: "S1" }));
  await settle(t.f);
  await finishB(t);
  assert.equal(t.f.store.getRun("h#1")?.current, "c");
  assert.equal(t.f.plugins.status().find((p) => p.name === "fakechat")?.lastError, "no rights");
  await t.f.close();
});

const tell = async (t: { f: any }, address: string, text: string) => {
  chatCtx().message({ address, text, from: "Ann" });
  await settle(t.f);
};

test("a message in the conversation is typed to the run's agent once its turn has ended", async () => {
  const t = await running();
  await t.f.say({ session: "S1", text: "plan?" });
  await t.f.submit(status("S1", "active"));
  t.clock.t += 17_000;
  await tell(t, "T1", "go on,\nbut keep the tests");
  assert.ok(!t.agterm.typed().some((x) => x.includes("Ann")));
  await t.f.submit(status("S1", "completed"));
  await settle(t.f);
  assert.equal(t.agterm.typed().at(-1), "type S1 Ann (fakechat): go on,\nbut keep the tests");
  await t.f.close();
});

test("a message in a root's conversation goes to the nested run's agent", async () => {
  resetChat();
  const t = await startFlowd(makeHome({ ...STEP_FILES, ...OUTER, ...LEAF, ...CHAT_ON }));
  t.agterm.addSession("S1");
  await t.f.submit(start("outer", { pm: "S1" }, { inner: ["leaf"] }));
  await settle(t.f);
  await finishB(t);
  await t.f.say({ session: "S1", text: "hi" });
  await t.f.submit(status("S1", "active"));
  await tell(t, "T1", "yes");
  assert.deepEqual(t.f.store.pendingOutbox().map((r) => [r.run_id, r.text]), [["leaf#1", "Ann (fakechat): yes"]]);
  await t.f.close();
});

test("with no agent on a step, or an ended run, the message is answered and not typed", async () => {
  resetChat();
  const t = await startFlowd(makeHome({ ...STEP_FILES, ...HUMAN, ...CHAT_ON }));
  t.agterm.addSession("S1");
  await t.f.submit(start("h", { pm: "S1" }));
  await settle(t.f);
  await finishB(t);
  await tell(t, "T1", "hello?");
  assert.equal(chatLog().at(-1), "post T1 no agent is on a step now: h#1 is at c (human). Write again when one is");
  assert.deepEqual(t.f.store.pendingOutbox(), []);
  await t.f.submit({ type: "entry.report", data: { run: "h#1", entry: "c", outcome: "done", by: "human" }, source: "cli" });
  await settle(t.f);
  await tell(t, "T1", "and now?");
  assert.equal(chatLog().at(-1), "post T1 h#1 has ended");
  const before = chatLog().length;
  await tell(t, "T9", "lost");
  assert.equal(chatLog().length, before);
  await t.f.close();
});

test("with reports served, flow say sends an HTML file as a link; other files and no reports still go as files", async () => {
  resetChat();
  const home = makeHome({ ...STEP_FILES, ...TWO, ...CHAT_ON });
  const t = await startFlowd(home, { reports: { dir: join(home, "reports"), url: "https://reports.example.net" } });
  t.agterm.addSession("S1");
  await t.f.submit(start("p", { pm: "S1" }));
  await settle(t.f);
  writeFileSync(join(home, "plan.html"), "<p>plan</p>");
  writeFileSync(join(home, "log.pdf"), "%PDF");
  assert.deepEqual(await t.f.say({ session: "S1", text: "the plan", file: join(home, "plan.html") }), {});
  assert.deepEqual(await t.f.say({ session: "S1", text: "the log", file: join(home, "log.pdf") }), {});
  assert.match(chatLog()[1], /^post T1 the plan\nhttps:\/\/reports\.example\.net\/r\/[0-9a-f]{32}\/plan\.html$/);
  assert.equal(chatLog()[2], `post T1 the log +${join(home, "log.pdf")}`);
  assert.match((t.f.publish(join(home, "plan.html")) as { url: string }).url, /^https:\/\/reports\.example\.net\/r\//);
  await t.f.close();

  const off = await running();
  writeFileSync(join(off.home, "plan.html"), "<p>plan</p>");
  await off.f.say({ session: "S1", text: "the plan", file: join(off.home, "plan.html") });
  assert.equal(chatLog().at(-1), `post T1 the plan +${join(off.home, "plan.html")}`);
  assert.deepEqual(off.f.publish(join(off.home, "plan.html")), { error: "reports are not served: set FLOWS_REPORTS_URL (docs/cli.md#flow-publish)" });
  await off.f.close();
});
