import { createHash, createPublicKey, randomBytes, verify as verifySig } from "node:crypto";
import { Bot, GrammyError, InputFile } from "grammy";
import type { Plugin, PluginCtx } from "../src/plugins.ts";

// Telegram's limits: a message, a document's caption, a topic's name
const TEXT = 4096, CAPTION = 1024, NAME = 128;

let bot: Bot | undefined;

const attr = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const b64url = (b: Buffer) => b.toString("base64url");

// Log in with Telegram: OpenID Connect, code flow with PKCE (core.telegram.org/bots/telegram-login)
const ISSUER = "https://oauth.telegram.org";
// each login page's state → its PKCE verifier; flowd's memory is enough: a restart only means "log in again"
const pending = new Map<string, { verifier: string; expires: number }>();
let jwks: { keys: { kid?: string }[] } | undefined;

interface Config { token: string; chat: number; users: number[] }

const oauthRoot = (ctx: PluginCtx) => (typeof ctx.config.oauth_root === "string" ? ctx.config.oauth_root : ISSUER);
/** BotFather's Client ID is the bot's id, the token's first part. */
const clientId = (c: Config) => c.token.split(":")[0];

async function keyFor(kid: string, ctx: PluginCtx) {
  let k = jwks?.keys.find((x) => x.kid === kid);
  if (!k) { // first use, or Telegram rotated its keys
    const r = await fetch(`${oauthRoot(ctx)}/.well-known/jwks.json`);
    if (!r.ok) throw new Error(`Telegram's keys: HTTP ${r.status}`);
    jwks = await r.json() as typeof jwks;
    k = jwks!.keys.find((x) => x.kid === kid);
  }
  if (!k) throw new Error(`Telegram has no key ${kid}`);
  return createPublicKey({ key: k as JsonWebKey, format: "jwk" });
}

/** Checks Telegram's ID token: its RS256 signature by Telegram's published key, issuer, audience, expiry. */
export async function checkIdToken(jwt: string, audience: string, ctx: PluginCtx, nowSec = Date.now() / 1000): Promise<Record<string, unknown>> {
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) throw new Error("the ID token is not a JWT");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  if (header.alg !== "RS256") throw new Error(`the ID token is signed with ${header.alg}; set the bot's signing algorithm to RS256 in BotFather`);
  if (!verifySig("RSA-SHA256", Buffer.from(`${h}.${p}`), await keyFor(header.kid, ctx), Buffer.from(sig, "base64url"))) throw new Error("the ID token's signature is wrong");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)];
  if (claims.iss !== ISSUER) throw new Error(`the ID token comes from ${claims.iss}, not Telegram`);
  if (!aud.includes(audience)) throw new Error("the ID token is for another bot");
  if (!(Number(claims.exp) > nowSec)) throw new Error("the ID token has expired; log in again");
  return claims;
}

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

/** A topic name fits 128 characters by cutting what comes before its last " · " (the title), not the label after it. */
const fit = (name: string) => {
  if (name.length <= NAME) return name;
  const at = name.lastIndexOf(" · ");
  const tail = at > 0 && name.length - at < NAME / 2 ? name.slice(at) : "";
  return `${name.slice(0, NAME - tail.length - 1)}…${tail}`;
};

const where = (address: string) => {
  const [chat, topic] = address.split("/").map(Number);
  return { chat, topic };
};

export default {
  name: "telegram",
  chat: {
    async open(run, ctx) {
      const chat = config(ctx).chat;
      const topic = await call(api(ctx).createForumTopic(chat, fit(run.name)));
      return `${chat}/${topic.message_thread_id}`;
    },
    async rename(address, name, ctx) {
      const { chat, topic } = where(address);
      await call(api(ctx).editForumTopic(chat, topic, { name: fit(name) }));
    },
    async post(address, m, ctx) {
      const { chat, topic } = where(address);
      const opts = { message_thread_id: topic };
      const caption = m.file && m.text.length <= CAPTION;
      // no previews: one makes Telegram's servers fetch the link, and a report's link is its only key
      if (!caption) for (const p of parts(m.text)) await call(api(ctx).sendMessage(chat, p, { ...opts, link_preview_options: { is_disabled: true } }));
      if (m.file) await call(api(ctx).sendDocument(chat, new InputFile(m.file), caption ? { ...opts, caption: m.text } : opts));
    },
    async close(address, _end, ctx) {
      const { chat, topic } = where(address);
      await call(api(ctx).closeForumTopic(chat, topic));
    },
  },
  login: {
    page(o, ctx) {
      const c = config(ctx);
      const now = Date.now();
      for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
      const state = b64url(randomBytes(16));
      const verifier = b64url(randomBytes(32));
      pending.set(state, { verifier, expires: now + 10 * 60_000 });
      const q = new URLSearchParams({
        client_id: clientId(c), redirect_uri: o.callback, response_type: "code", scope: "openid profile", state,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
      });
      return `<p><a href="${attr(`${oauthRoot(ctx)}/auth?${q}`)}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#2aabee;color:#fff;text-decoration:none;font-weight:600">Log in with Telegram</a></p>`
        + `<p style="opacity:.7;font-size:14px">Only the people in users of plugins.yaml get in.</p>`;
    },
    async verify(q, o, ctx) {
      const c = config(ctx);
      if (q.error) return { error: `Telegram said ${q.error}${q.error_description ? `: ${q.error_description}` : ""}` };
      const p = q.state ? pending.get(q.state) : undefined;
      if (!p || p.expires < Date.now() || !q.code) return { error: "this login link is old or was used; start again" };
      pending.delete(q.state);
      if (typeof ctx.config.client_secret !== "string") return { error: "telegram needs client_secret (BotFather → the bot → Login Widget) in plugins.yaml" };
      const r = await fetch(`${oauthRoot(ctx)}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${clientId(c)}:${ctx.config.client_secret}`).toString("base64")}` },
        body: new URLSearchParams({ grant_type: "authorization_code", code: q.code, redirect_uri: o.callback, client_id: clientId(c), code_verifier: p.verifier }),
      });
      const t = await r.json().catch(() => ({})) as { id_token?: string; error?: string; error_description?: string };
      if (!r.ok || !t.id_token) return { error: `Telegram did not give a token: ${t.error_description ?? t.error ?? `HTTP ${r.status}`}` };
      const claims = await checkIdToken(t.id_token, clientId(c), ctx);
      const id = Number(claims.id ?? claims.sub);
      if (!c.users.includes(id)) return { error: `Telegram user ${claims.id ?? claims.sub} is not in users in plugins.yaml` };
      return { user: String(id), name: String(claims.name ?? claims.preferred_username ?? id) };
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
