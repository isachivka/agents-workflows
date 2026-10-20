import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CORE_EVENTS } from "./defs.ts";
import type { Dict, FlowEvent, Outcome } from "./types.ts";

export interface PluginEvent { type: string; data?: Dict; outcome?: Outcome; run?: string; entry?: string }
/** A wait (run and entry set) or a trigger subscription (no run; shared by `processes`). */
export interface Watch {
  type: string;
  with: Dict;
  cwd: string;
  run?: string;
  entry?: string;
  vars: Record<string, string>;
  processes?: string[];
  /** A wait re-armed in the same iteration: the event that last woke its entry. */
  previous?: { type: string; data: Dict };
}
/** What a chat adapter hands flowd: a message the person wrote in a run's conversation. */
export interface ChatMessage { address: string; text: string; from: string }
/** A messenger: one conversation per run (a topic, a channel, a thread). */
export interface ChatAdapter {
  /** opens the run's conversation, called `run.name`; returns its address, kept by flowd */
  open(run: { id: string; process: string; title?: string; name: string }, ctx: PluginCtx): Promise<string> | string;
  /** the run's name changed (its title came or changed) while its conversation is open */
  rename?(address: string, name: string, ctx: PluginCtx): Promise<unknown> | unknown;
  post(address: string, msg: { text: string; file?: string }, ctx: PluginCtx): Promise<unknown> | unknown;
  close(address: string, end: { outcome: "done" | "stopped" }, ctx: PluginCtx): Promise<unknown> | unknown;
}
export interface ActiveChat { name: string; chat: ChatAdapter; ctx: PluginCtx }
/** A way to log in to the UI from outside: a page with the provider's button, and its callback's check. */
export interface LoginProvider {
  /** the login page's body: the provider's button, which comes back to `callback` (/auth/<plugin name>) */
  page(o: { callback: string }, ctx: PluginCtx): string;
  /** the callback's query → who logged in, or why not; `callback` is the redirect URI the page used */
  verify(query: Record<string, string>, o: { callback: string }, ctx: PluginCtx):
    Promise<{ user: string; name: string } | { error: string }> | { user: string; name: string } | { error: string };
}
export interface ActiveLogin { name: string; login: LoginProvider; ctx: PluginCtx }
export interface PluginCtx {
  emit(e: PluginEvent): void;
  /** a chat adapter: a message in a run's conversation, from someone the adapter lets write */
  message(m: ChatMessage): void;
  log(msg: string): void;
  error(err: unknown, w?: Watch): void;
  config: Dict;
}
export interface Plugin {
  name: string;
  events?: string[];
  start?(ctx: PluginCtx): unknown;
  watch?(w: Watch, ctx: PluginCtx): (() => void) | void;
  actions?: Record<string, (args: Dict, ctx: PluginCtx) => unknown>;
  /** What a run is about, in words (a PR's title), from its vars; flowd keeps it in vars.title. */
  title?(run: { vars: Record<string, string>; cwd: string }, ctx: PluginCtx): Promise<string | undefined> | string | undefined;
  /** when flowd stops: end what `start` began (a poll, a socket) */
  stop?(ctx: PluginCtx): Promise<unknown> | unknown;
  /** a messenger for runs' conversations; it is the active one when plugins.yaml has its section */
  chat?: ChatAdapter;
  /** a login for the UI from outside (FLOWD_PUBLIC_URL); active like chat */
  login?: LoginProvider;
}
export interface PluginStatus {
  name: string;
  source: string;
  events: string[];
  actions: string[];
  lastError: string | null;
  watches: { run: string | null; entry: string | null; type: string; processes: string[] | null; error: string | null }[];
}

interface Loaded { plugin: Plugin; ctx: PluginCtx; source: string; lastError?: string }
interface Active { key: string; w: Watch; stop?: () => void; error?: string; attempt: number; retry?: ReturnType<typeof setTimeout> }

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const key = (run: string, entry: string) => `${run}\u0000${entry}`;
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
export const subscriptionKey = (w: Pick<Watch, "type" | "cwd" | "with">) => `trigger\u0000${w.type}\u0000${w.cwd}\u0000${stable(w.with)}`;
const keyOf = (w: Watch) => (w.run ? key(w.run, w.entry ?? "") : subscriptionKey(w));
const RESERVED = new Set(["flow", "signal"]);

export class PluginHost {
  loaded = new Map<string, Loaded>();
  loadErrors: Record<string, string> = {};
  active = new Map<string, Active>();
  dirs: string[];
  config: Record<string, Dict>;
  sink: (e: FlowEvent) => void;
  onMessage: (adapter: string, m: ChatMessage) => void;
  log: (m: string) => void;
  retryBaseMs: number;

  constructor(o: { dirs: string[]; config: Record<string, Dict>; sink: (e: FlowEvent) => void; log?: (m: string) => void; retryBaseMs?: number;
    onMessage?: (adapter: string, m: ChatMessage) => void }) {
    this.dirs = o.dirs;
    this.config = o.config;
    this.sink = o.sink;
    this.onMessage = o.onMessage ?? (() => {});
    this.log = o.log ?? ((m) => console.error(m));
    this.retryBaseMs = o.retryBaseMs ?? 5_000;
  }

  async load(): Promise<void> {
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) {
        const file = join(dir, f);
        try {
          const mod = await import(pathToFileURL(file).href);
          const plugin = mod.default as Plugin;
          if (!plugin || typeof plugin !== "object" || typeof plugin.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(plugin.name)) {
            throw new Error("the default export must be a plugin object with a lowercase name");
          }
          if (RESERVED.has(plugin.name)) throw new Error(`plugin name ${plugin.name} is reserved`);
          this.add(plugin, file);
          delete this.loadErrors[plugin.name];
        } catch (e) {
          this.loadErrors[basename(f, ".ts")] = msg(e);
          this.log(`plugin ${file}: ${msg(e)}`);
        }
      }
    }
    for (const kind of ["chat", "login"] as const) {
      const a = this.activeOf(kind);
      if (a && "error" in a) this.loadErrors[kind] = a.error;
      else delete this.loadErrors[kind];
    }
  }

  /** The plugin providing `kind` whose name has a section in plugins.yaml; two are an error. */
  private activeOf(kind: "chat" | "login"): Loaded | { error: string } | null {
    const on = [...this.loaded.values()].filter((l) => l.plugin[kind] && l.plugin.name in this.config);
    const what = kind === "chat" ? "chat adapters" : "logins";
    if (on.length > 1) return { error: `two ${what} are set up (${on.map((l) => l.plugin.name).join(", ")}): keep one section in plugins.yaml` };
    return on[0] ?? null;
  }

  /** The active chat adapter: a plugin with `chat` whose name has a section in plugins.yaml. */
  chat(): ActiveChat | { error: string } | null {
    const a = this.activeOf("chat");
    return a && "plugin" in a ? { name: a.plugin.name, chat: a.plugin.chat!, ctx: a.ctx } : a;
  }

  /** The active login for the UI from outside. */
  login(): ActiveLogin | { error: string } | null {
    const a = this.activeOf("login");
    return a && "plugin" in a ? { name: a.plugin.name, login: a.plugin.login!, ctx: a.ctx } : a;
  }

  /** Shown in Settings → Plugins; a chat adapter's failure does not fail the run that caused it. */
  fault(name: string, e: unknown): void {
    const l = this.loaded.get(name);
    if (l) l.lastError = msg(e);
    this.log(`[${name}] ${msg(e)}`);
  }

  add(plugin: Plugin, source = "inline"): void {
    const name = plugin.name;
    const ctx: PluginCtx = {
      config: this.config[name] ?? {},
      log: (m) => this.log(`[${name}] ${m}`),
      error: (err, w) => {
        const a = w ? this.active.get(keyOf(w)) : undefined;
        if (err === null || err === undefined) { // the plugin works again
          if (a) a.error = undefined;
          return;
        }
        const l = this.loaded.get(name);
        if (l) l.lastError = msg(err);
        if (a) a.error = msg(err);
        this.log(`[${name}] ${msg(err)}`);
      },
      emit: (e) => this.emitFrom(name, e),
      message: (m) => this.onMessage(name, m),
    };
    this.loaded.set(name, { plugin, ctx, source });
  }

  private emitFrom(name: string, e: PluginEvent, subscription?: string): void {
    const type = e.type.startsWith(`${name}.`) ? e.type : `${name}.${e.type}`;
    const ev: FlowEvent = { type, data: e.data ?? {}, outcome: e.outcome, run: e.run, entry: e.entry, source: name };
    if (subscription && !e.run) ev.subscription = subscription; // starts only the processes that asked for it
    this.sink(ev);
  }

  eventTypes(): Set<string> {
    const types = new Set(CORE_EVENTS);
    for (const { plugin } of this.loaded.values()) for (const e of plugin.events ?? []) types.add(`${plugin.name}.${e}`);
    return types;
  }

  actionNames(): Set<string> {
    const names = new Set<string>();
    for (const { plugin } of this.loaded.values()) for (const a of Object.keys(plugin.actions ?? {})) names.add(`${plugin.name}.${a}`);
    return names;
  }

  startAll(): void {
    for (const l of this.loaded.values()) {
      if (!l.plugin.start) continue;
      try {
        Promise.resolve(l.plugin.start(l.ctx)).catch((e) => l.ctx.error(e));
      } catch (e) {
        l.ctx.error(e);
      }
    }
  }

  /** A wait is keyed by its run and entry, a trigger subscription by type, cwd and with. */
  watch(w: Watch): void {
    const k = keyOf(w);
    this.drop(k);
    const a: Active = { key: k, w, attempt: 0 };
    this.active.set(k, a);
    this.arm(a);
  }

  private arm(a: Active): void {
    const l = this.loaded.get(a.w.type.split(".")[0]);
    if (!l?.plugin.watch) return; // flow.* and signal.* arrive without a watcher
    try {
      // a trigger subscription gets its own emit, which stamps its key on what it sends
      const ctx = a.w.run ? l.ctx : { ...l.ctx, emit: (e: PluginEvent) => this.emitFrom(l.plugin.name, e, a.key) };
      a.stop = l.plugin.watch(a.w, ctx) || undefined;
      a.error = undefined;
      a.attempt = 0;
    } catch (e) {
      l.ctx.error(e, a.w);
      const delay = Math.min(this.retryBaseMs * 2 ** a.attempt++, 300_000);
      a.retry = setTimeout(() => {
        if (this.active.get(a.key) === a) this.arm(a);
      }, delay);
    }
  }

  unwatch(run: string, entry: string): void {
    this.drop(key(run, entry));
  }

  unsubscribe(k: string): void {
    this.drop(k);
  }

  subscription(k: string): Watch | undefined {
    return this.active.get(k)?.w;
  }

  subscriptionKeys(): string[] {
    return [...this.active.values()].filter((a) => !a.w.run).map((a) => a.key);
  }

  private drop(k: string): void {
    const a = this.active.get(k);
    if (!a) return;
    clearTimeout(a.retry);
    try {
      a.stop?.();
    } catch (e) {
      this.log(`unwatch ${a.w.type}: ${msg(e)}`);
    }
    this.active.delete(k);
  }

  /** The first title a plugin gives for these vars; a failing plugin is skipped (its error shows in its status). */
  async titleOf(vars: Record<string, string>, cwd: string): Promise<string | undefined> {
    for (const l of this.loaded.values()) {
      if (!l.plugin.title) continue;
      try {
        const t = await l.plugin.title({ vars, cwd }, l.ctx);
        if (typeof t === "string" && t.trim()) return t.trim();
      } catch (e) {
        l.lastError = msg(e);
      }
    }
    return undefined;
  }

  async runAction(name: string, args: Dict): Promise<unknown> {
    const [plugin, ...rest] = name.split(".");
    const l = this.loaded.get(plugin);
    const fn = l?.plugin.actions?.[rest.join(".")];
    if (!l || !fn) throw new Error(`no action ${name}`);
    try {
      return await fn(args, l.ctx);
    } catch (e) {
      l.lastError = msg(e);
      throw e;
    }
  }

  status(): PluginStatus[] {
    const watches = [...this.active.values()];
    const loaded = [...this.loaded.values()].map((l) => ({
      name: l.plugin.name,
      source: l.source,
      events: l.plugin.events ?? [],
      actions: Object.keys(l.plugin.actions ?? {}),
      lastError: l.lastError ?? null,
      watches: watches
        .filter((a) => a.w.type.startsWith(`${l.plugin.name}.`))
        .map((a) => ({ run: a.w.run ?? null, entry: a.w.entry ?? null, type: a.w.type, processes: a.w.processes ?? null, error: a.error ?? null })),
    }));
    const failed = Object.entries(this.loadErrors).map(([name, err]) => ({ name, source: "", events: [], actions: [], lastError: err, watches: [] }));
    return [...loaded, ...failed];
  }

  async stopAll(): Promise<void> {
    for (const a of [...this.active.values()]) this.drop(a.key);
    await Promise.all([...this.loaded.values()].map(async (l) => {
      try {
        await l.plugin.stop?.(l.ctx);
      } catch (e) {
        this.log(`[${l.plugin.name}] stop: ${msg(e)}`);
      }
    }));
  }
}

/** `$FLOWS_HOME/plugins.yaml`: one section per plugin name. */
export function readPluginConfig(home: string, log: (m: string) => void): Record<string, Dict> {
  const path = join(home, "plugins.yaml");
  if (!existsSync(path)) return {};
  try {
    const parsed = parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Dict>) : {};
  } catch (e) {
    log(`plugins.yaml: ${msg(e)}`);
    return {};
  }
}
