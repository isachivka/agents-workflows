import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { CHAT_ON, STEP_FILES, chatLog, makeHome, proc, resetChat, settle, startFlowd } from "./daemon-helpers.ts";

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
