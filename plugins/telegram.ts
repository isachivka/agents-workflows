import { Bot, GrammyError, InputFile } from "grammy";
import type { Plugin, PluginCtx } from "../src/plugins.ts";

// Telegram's limits: a message, a document's caption, a topic's name
const TEXT = 4096, CAPTION = 1024, NAME = 128;

let bot: Bot | undefined;

interface Config { token: string; chat: number; users: number[] }

function config(ctx: PluginCtx): Config {
  const c = ctx.config;
  if (typeof c.token !== "string" || !c.token || typeof c.chat !== "number" || !Array.isArray(c.users)) {
    throw new Error("telegram needs token, chat (the group's id) and users (who may write to agents) in plugins.yaml");
  }
  return { token: c.token, chat: c.chat, users: c.users.map(Number) };
}

function api(ctx: PluginCtx) {
  if (!bot) bot = new Bot(config(ctx).token, typeof ctx.config.api_root === "string" ? { client: { apiRoot: ctx.config.api_root } } : {});
  return bot.api;
}

/** Bot API errors with what to do about the usual ones. */
async function call<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const d = e instanceof GrammyError ? e.description : String(e);
    if (/not enough rights|CHAT_ADMIN_REQUIRED/i.test(d)) throw new Error(`${d}: make the bot an admin of the group with "Manage topics"`);
    if (/chat not found/i.test(d)) throw new Error(`${d}: check chat in plugins.yaml (a group id starts with -100) and that the bot is in the group`);
    if (/not a forum|TOPICS?_DISABLED/i.test(d)) throw new Error(`${d}: turn on Topics in the group's settings`);
    throw new Error(d);
  }
}

/** Cuts text into Telegram messages, at a line break when one is near the limit. */
export function parts(text: string, max = TEXT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const nl = rest.lastIndexOf("\n", max);
    const at = nl > max / 2 ? nl : max;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  out.push(rest);
  return out;
}

const where = (address: string) => {
  const [chat, topic] = address.split("/").map(Number);
  return { chat, topic };
};

export default {
  name: "telegram",
  chat: {
    async open(run, ctx) {
      const name = `${run.id.replace("#", " #")}${run.title ? ` · ${run.title}` : ""}`;
      const chat = config(ctx).chat;
      const topic = await call(api(ctx).createForumTopic(chat, name.length > NAME ? `${name.slice(0, NAME - 1)}…` : name));
      return `${chat}/${topic.message_thread_id}`;
    },
    async post(address, m, ctx) {
      const { chat, topic } = where(address);
      const opts = { message_thread_id: topic };
      const caption = m.file && m.text.length <= CAPTION;
      if (!caption) for (const p of parts(m.text)) await call(api(ctx).sendMessage(chat, p, opts));
      if (m.file) await call(api(ctx).sendDocument(chat, new InputFile(m.file), caption ? { ...opts, caption: m.text } : opts));
    },
    async close(address, _end, ctx) {
      const { chat, topic } = where(address);
      await call(api(ctx).closeForumTopic(chat, topic));
    },
  },
  start(ctx) {
    if (!ctx.config.token) return; // not set up: the plugin does nothing
    const c = config(ctx);
    api(ctx);
    bot!.on("message", (t) => {
      const m = t.message;
      if (m.chat.id !== c.chat || !m.is_topic_message || !m.message_thread_id) return;
      const text = m.text ?? m.caption;
      if (!text) return;
      if (!m.from || !c.users.includes(m.from.id)) {
        ctx.log(`a message from ${m.from?.id ?? "nobody"} (${m.from?.username ?? m.from?.first_name ?? "?"}), who is not in users, is ignored`);
        return;
      }
      ctx.message({ address: `${c.chat}/${m.message_thread_id}`, text, from: m.from.first_name });
    });
    bot!.catch((e) => ctx.error(e.error));
    // runs until stop; a second poller with this token (another flowd) makes Telegram refuse it
    bot!.start({ allowed_updates: ["message"] }).catch((e) => {
      const m = msgOf(e);
      ctx.error(new Error(/409|conflict/i.test(m) ? `${m}: another flowd polls with this bot's token; give each flowd its own bot` : m));
    });
  },
  async stop() {
    const b = bot;
    bot = undefined;
    await b?.stop();
  },
} satisfies Plugin;

const msgOf = (e: unknown) => (e instanceof GrammyError ? e.description : e instanceof Error ? e.message : String(e));
