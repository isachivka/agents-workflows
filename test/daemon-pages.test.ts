import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { CHAT_PLUGIN, STEP_FILES, chatLog, makeHome, proc, resetChat, settle, startFlowd } from "./daemon-helpers.ts";

const TWO = proc("  - {step: b, role: pm}\n  - {step: c, role: pm}\n");

/** A pages adapter that records what flowd asks of it; its page links are https://pages.example.net/q/<id>. */
const PAGES_PLUGIN = `const g = globalThis as any;
export default {
  name: "fakepages",
  pages: {
    async ask(q: any, ctx: any) {
      g.__pagesCtx = ctx;
      if (g.__pagesFail) throw new Error("the store is down");
      (g.__pages ??= []).push("ask " + q.run + " " + q.process + " " + q.entry + " " + q.title + " " + q.fragment);
      return { url: "https://pages.example.net/q/" + q.id };
    },
    async close(id: string) {
      if (g.__pagesCloseFail) { g.__pagesCloseFail = false; throw new Error("busy"); }
      (g.__pages ??= []).push("close " + id);
    },
    async check(url: string) { if (url.includes("missing")) throw new Error("no such page"); },
  },
};
`;
const PAGES_ON = {
  "plugins/fakechat.ts": CHAT_PLUGIN, "plugins/fakepages.ts": PAGES_PLUGIN, "plugins.yaml": "fakechat: {}\nfakepages: {}\n",
};
const g = globalThis as any;
const pagesLog = (): string[] => (g.__pages ??= []);
const resetPages = () => { g.__pages = []; g.__pagesFail = false; g.__pagesCloseFail = false; g.__pagesCtx = undefined; };
const answer = (id: string, a: unknown) => g.__pagesCtx.answer({ id, answer: a });

const start = (process: string, bind: Record<string, string>) => ({ type: "run.start", data: { process, bind }, source: "test" });
const status = (session: string, s: string) => ({ type: "agterm.status", data: { session, status: s }, source: "agterm" });
const done = (session: string) => ({ type: "entry.report", data: { session, outcome: "done" }, source: "cli" });

async function running(files: Record<string, string> = PAGES_ON, opts = {}) {
  resetChat();
  resetPages();
  const home = makeHome({ ...STEP_FILES, ...TWO, ...files });
  const t = await startFlowd(home, opts);
  t.agterm.addSession("S1");
  await t.f.submit(start("p", { pm: "S1" }));
  await settle(t.f);
  writeFileSync(join(home, "q.html"), '<input type="checkbox" name="choice" value="a">');
  return { ...t, home };
}

const yourQuestion = (calls: string[]) => calls.filter((c) => c.startsWith("type S1") && c.includes("your question"));

test("flow ask with a pages adapter: the plugin makes the page, flowd waits, posts its link, and types the answers it hands back", async () => {
  const t = await running();
  await t.f.submit(status("S1", "active"));
  const r = await t.f.ask({ session: "S1", file: join(t.home, "q.html"), note: "Which to make?" });
  assert.ok("url" in r, JSON.stringify(r));
  const id = /\/q\/([0-9a-f]{32})$/.exec(r.url)![1];
  assert.deepEqual(pagesLog(), ['ask p#1 p b Which to make? <input type="checkbox" name="choice" value="a">']);
  assert.equal(chatLog().at(-1), `post T1 Which to make?\n${r.url}`);
  const run = t.f.store.getRun("p#1")!;
  assert.deepEqual([run.entries.b.wait?.human, run.entries.b.wait?.note], [true, `Which to make? · ${r.url}`]);
  assert.equal(t.f.store.question(id)?.adapter, "fakepages");
  assert.equal(t.f.reports, undefined); // nothing is copied or served by flowd

  await t.f.submit(status("S1", "completed"));
  answer(id, { choice: "a", note: "this one" });
  t.clock.t += 60_000;
  await settle(t.f);
  let typed = yourQuestion(t.agterm.calls);
  assert.equal(typed.length, 1, t.agterm.calls.join("\n"));
  assert.ok(typed[0].includes(`the person answered your question (${r.url}):\n{"choice":["a"],"note":"this one"}`), typed[0]);

  // a malformed one and one for a question nobody asked are dropped; a second is a change
  answer(id, { choice: 1 });
  answer("f".repeat(32), { choice: ["a"] });
  await t.f.submit(status("S1", "completed"));
  answer(id, { choice: [] });
  t.clock.t += 60_000;
  await settle(t.f);
  typed = yourQuestion(t.agterm.calls);
  assert.equal(typed.length, 2, t.agterm.calls.join("\n"));
  assert.ok(typed[1].includes("changed their answer to"), typed[1]);

  // the run moves on: the next tick closes the question once; a late answer goes nowhere
  await t.f.submit(status("S1", "active"));
  await t.f.submit(done("S1"));
  await settle(t.f);
  await t.f.tickNow();
  await t.f.tickNow();
  assert.deepEqual(pagesLog().filter((l) => l.startsWith("close")), [`close ${id}`]);
  assert.ok(t.f.store.question(id)?.closed);
  answer(id, { choice: ["a"] });
  t.clock.t += 60_000;
  await settle(t.f);
  assert.equal(yourQuestion(t.agterm.calls).length, 2);
  await t.f.close();
});

test("a failing ask sets no wait and says why; a failing close is tried again at the next tick", async () => {
  const t = await running();
  g.__pagesFail = true;
  const r = await t.f.ask({ session: "S1", file: join(t.home, "q.html"), note: "x" });
  assert.deepEqual(r, { error: "fakepages: the store is down" });
  assert.equal(t.f.store.getRun("p#1")!.entries.b.wait, undefined);
  g.__pagesFail = false;
  const ok = await t.f.ask({ session: "S1", file: join(t.home, "q.html"), note: "x" });
  const id = /\/q\/([0-9a-f]{32})$/.exec((ok as { url: string }).url)![1];
  await t.f.submit(status("S1", "active"));
  await t.f.submit(done("S1"));
  await settle(t.f);
  g.__pagesCloseFail = true;
  await t.f.tickNow();
  assert.equal(t.f.store.question(id)?.closed, undefined);
  assert.match(t.f.plugins.status().find((p) => p.name === "fakepages")!.lastError ?? "", /busy/);
  await t.f.tickNow();
  assert.deepEqual(pagesLog().filter((l) => l.startsWith("close")), [`close ${id}`]);
  await t.f.close();
});

test("two pages adapters are refused; with neither an adapter nor the listener flow ask says what to set up", async () => {
  const two = await running({ ...PAGES_ON, "plugins/otherpages.ts": PAGES_PLUGIN.replace('"fakepages"', '"otherpages"'),
    "plugins.yaml": "fakechat: {}\nfakepages: {}\notherpages: {}\n" });
  assert.match((await two.f.ask({ session: "S1", file: join(two.home, "q.html"), note: "x" }) as { error: string }).error,
    /two pages adapters are set up \(fakepages, otherpages\)/);
  await two.f.close();

  const listener = await running({}, {});
  const r = await listener.f.ask({ session: "S1", file: join(listener.home, "q.html"), note: "x" });
  assert.match((r as { error: string }).error, /question pages need a pages adapter \(a plugin with `pages`\) or the reports listener/);
  await listener.f.close();
});

test("flow say --link posts each link on its own line; a link that is not http(s), or one the adapter refuses, is not sent", async () => {
  const t = await running();
  assert.deepEqual(await t.f.say({ session: "S1", text: "The plan", links: ["https://pages.example.net/1", "http://x.example/2"] }), {});
  assert.equal(chatLog().at(-1), "post T1 The plan\nhttps://pages.example.net/1\nhttp://x.example/2");
  const n = chatLog().length;
  assert.deepEqual(await t.f.say({ session: "S1", text: "x", links: ["file:///etc/passwd"] }),
    { error: "file:///etc/passwd: a link starts with https:// or http://" });
  assert.deepEqual(await t.f.say({ session: "S1", text: "x", links: ["https://pages.example.net/missing"] }),
    { error: "fakepages refused https://pages.example.net/missing: no such page" });
  // a page as a file has nowhere to go: the adapter takes questions, not files
  writeFileSync(join(t.home, "plan.html"), "<p>plan</p>");
  assert.match((await t.f.say({ session: "S1", text: "x", file: join(t.home, "plan.html") })).error ?? "",
    /pages are not served here: publish the page where fakepages keeps them and pass its link with --link/);
  assert.equal(chatLog().length, n);
  assert.deepEqual(t.f.publish(join(t.home, "plan.html")),
    { error: "reports are not served here: publish plan.html where fakepages keeps pages and post its link with flow say --link" });
  await t.f.close();
});
