import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import telegram, { parts } from "../plugins/telegram.ts";
import type { ChatMessage, PluginCtx } from "../src/plugins.ts";

/** A fake Bot API: records each call, serves getUpdates from a queue, answers the rest from `answers`. */
const calls: { method: string; body: string }[] = [];
const updates: unknown[] = [];
const answers: Record<string, unknown> = {
  getMe: { id: 1, is_bot: true, first_name: "flows", username: "flows_bot" },
  deleteWebhook: true,
  createForumTopic: { message_thread_id: 77, name: "x", icon_color: 0 },
  sendMessage: { message_id: 1, date: 0, chat: { id: -100, type: "supergroup" } },
  sendDocument: { message_id: 2, date: 0, chat: { id: -100, type: "supergroup" } },
  closeForumTopic: true,
};
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d)).on("end", () => {
    const method = req.url!.split("/").pop()!;
    if (method !== "getUpdates") calls.push({ method, body });
    const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
    if (method === "getUpdates") return setTimeout(() => reply(updates.splice(0)), 20);
    if (method === "createForumTopic" && body.includes("broken")) {
      return res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: not enough rights to manage topics" }));
    }
    reply(answers[method]);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

const got: ChatMessage[] = [];
const logs: string[] = [];
const ctx: PluginCtx = {
  config: { token: "123:abc", chat: -100, users: [5], api_root: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
  emit: () => {}, message: (m) => got.push(m), log: (m) => logs.push(m), error: (e) => logs.push(String(e)),
};
const chat = telegram.chat;
const json = (i: number) => JSON.parse(calls[i].body);

test("a run's topic is named after it and its address is chat/topic", async () => {
  calls.length = 0;
  assert.equal(await chat.open({ id: "obs-inv#12", process: "obs-inv", title: "A long title ".repeat(12) }, ctx), "-100/77");
  assert.equal(calls[0].method, "createForumTopic");
  assert.equal(json(0).chat_id, -100);
  assert.equal(json(0).name.length, 128);
  assert.ok(json(0).name.startsWith("obs-inv #12 · A long title"));
  await assert.rejects(chat.open({ id: "broken#1", process: "broken" }, ctx), /not enough rights to manage topics: make the bot an admin of the group with "Manage topics"/);
});

test("a long text goes as several messages into the topic; a file as a document with the text as caption", async () => {
  calls.length = 0;
  await chat.post("-100/77", { text: "a".repeat(3000) + "\n" + "b".repeat(3000) }, ctx);
  assert.deepEqual(calls.map((c) => c.method), ["sendMessage", "sendMessage"]);
  assert.deepEqual([json(0).message_thread_id, json(0).text.length, json(1).text.length], [77, 3000, 3000]);

  const file = join(mkdtempSync(join(tmpdir(), "flows-tg-")), "report.html");
  writeFileSync(file, "<p>report</p>");
  calls.length = 0;
  await chat.post("-100/77", { text: "the plan", file }, ctx);
  assert.deepEqual(calls.map((c) => c.method), ["sendDocument"]);
  assert.match(calls[0].body, /the plan/);
  assert.match(calls[0].body, /report\.html/);
  assert.match(calls[0].body, /<p>report<\/p>/);

  calls.length = 0;
  await chat.post("-100/77", { text: "x".repeat(2000), file }, ctx);
  assert.deepEqual(calls.map((c) => c.method), ["sendMessage", "sendDocument"]);

  calls.length = 0;
  await chat.close("-100/77", { outcome: "done" }, ctx);
  assert.deepEqual([calls[0].method, json(0).message_thread_id], ["closeForumTopic", 77]);
});

test("parts cuts at a line break near the limit, else at the limit", () => {
  assert.deepEqual(parts("abc", 5), ["abc"]);
  assert.deepEqual(parts("abcd\nefgh", 6), ["abcd", "efgh"]);
  assert.deepEqual(parts("abcdefgh", 3), ["abc", "def", "gh"]);
});

test("only an allowed user's text in a topic of the group reaches flowd", async () => {
  const msg = (id: number, extra: Record<string, unknown>) => ({
    update_id: id, message: { message_id: id, date: 0, chat: { id: -100, type: "supergroup" }, from: { id: 5, is_bot: false, first_name: "Ann" }, ...extra },
  });
  telegram.start(ctx);
  updates.push(
    msg(1, { text: "go on", is_topic_message: true, message_thread_id: 77 }),
    msg(2, { text: "stranger", is_topic_message: true, message_thread_id: 77, from: { id: 9, is_bot: false, first_name: "Eve" } }),
    msg(3, { text: "general chat" }),
    msg(4, { caption: "see the screenshot", is_topic_message: true, message_thread_id: 77 }),
    msg(5, { text: "elsewhere", is_topic_message: true, message_thread_id: 77, chat: { id: -200, type: "supergroup" } }),
  );
  for (let i = 0; got.length < 2 && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
  await telegram.stop();
  assert.deepEqual(got, [
    { address: "-100/77", text: "go on", from: "Ann" },
    { address: "-100/77", text: "see the screenshot", from: "Ann" },
  ]);
  assert.ok(logs.some((l) => l.includes("from 9 (Eve), who is not in users, is ignored")), logs.join("\n"));
});

test("without a token the plugin does nothing; chat calls say what to set up", async () => {
  const bare = { ...ctx, config: {} };
  telegram.start(bare);
  await assert.rejects(chat.open({ id: "p#1", process: "p" }, bare), /telegram needs token, chat \(the group's id\) and users/);
});
