import { existsSync, readdirSync } from "node:fs";
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
export interface PluginCtx {
  emit(e: PluginEvent): void;
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
  log: (m: string) => void;
  retryBaseMs: number;

  constructor(o: { dirs: string[]; config: Record<string, Dict>; sink: (e: FlowEvent) => void; log?: (m: string) => void; retryBaseMs?: number }) {
    this.dirs = o.dirs;
    this.config = o.config;
    this.sink = o.sink;
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

  stopAll(): void {
    for (const a of [...this.active.values()]) this.drop(a.key);
  }
}
