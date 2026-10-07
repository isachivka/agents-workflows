import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { Cron } from "croner";
import { loadDefs, type DefCtx } from "./defs.ts";
import { formatDuration, matches, newRun, renderData, renderPrompt, renderWith, step } from "./engine.ts";
import { EMPTY_INPUT_COLUMN, expandHome, shq, spawnCommand, type Agterm } from "./agterm.ts";
import { PluginHost, msg, subscriptionKey, type Watch } from "./plugins.ts";
import { Store, type OutboxRow, type StoredEvent } from "./store.ts";
import { renderTemplate } from "./template.ts";
import { TERMINAL } from "./types.ts";
import type { Defs, Dict, FlowEvent, Input, OnFail, RunState, SessionStatus, StepResult } from "./types.ts";

export interface FlowdOptions {
  home: string;
  statePath: string;
  agterm: Agterm;
  pluginDirs: string[];
  now?: () => number;
  tickMs?: number;
  flushMs?: number;
  gapMs?: number;
  spawnGraceMs?: number;
  watchDefs?: boolean;
  retryBaseMs?: number;
  log?: (m: string) => void;
  /** Claude Code's config, read to tell whether a spawn's folder is trusted */
  claudeConfig?: string;
  /** how often the folder-trust dialog is looked for after a spawn (30 looks) */
  trustPollMs?: number;
  /** how often every open run's title is re-read from its PR (0: never on a timer) */
  titleMs?: number;
  /** how a shell entry's command is run; the command is appended (default: a login zsh) */
  shell?: string[];
}

export interface Result { error?: string; run?: string }

export interface PlanItem {
  id: string; kind: string; role: string | null; detour: boolean; waitFor: string | null; status: string;
  step: string | null; summary: string | null; do: string | null; startedAt: number | null; note: string | null;
  onFail: OnFail; after: { goto: string } | null;
  /** a pause entry's length (ms) */
  waitMs: number | null;
  /** a shell entry's command */
  sh: string | null;
}

export interface RunSummary {
  id: string; process: string; iteration: number; status: string; reason: string | null;
  current: string | null; currentStatus: string | null; currentKind: string | null; waitingOn: string | null;
  roles: Record<string, string | null>; vars: Record<string, string>; needsYou: boolean;
  agentWait: { note: string; human: boolean; since: number } | null;
  /** the current entry is a pause: when it ends (ms) */
  waitUntil: number | null;
  /** queued for a hold: its name and the run that has it */
  heldBy: { hold: string; run: string | null } | null;
  created: number; updated: number;
  plan: PlanItem[];
}

const AGTERM_STATUSES = new Set(["active", "completed", "idle", "blocked"]);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const stringVars = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(v && typeof v === "object" ? (v as Dict) : {}).map(([k, x]) => [k, String(x)]));

function readPluginConfig(home: string, log: (m: string) => void): Record<string, Dict> {
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

export class Flowd {
  home: string;
  store: Store;
  agterm: Agterm;
  plugins: PluginHost;
  defs: Defs = { processes: {}, steps: {}, invalid: {} };
  now: () => number;
  private o: FlowdOptions;
  private log: (m: string) => void;
  private chain: Promise<unknown> = Promise.resolve();
  /** work started beside the event chain (answering a trust dialog); idle() and close() wait for it */
  private side = new Set<Promise<unknown>>();
  /** running shell entries, killed on close */
  private children = new Set<ChildProcess>();
  private closing = false;
  private listeners = new Set<(what: "runs" | "defs") => void>();
  private lastTyped = new Map<string, number>();
  private spawning = new Set<string>();
  private flushRun: Promise<void> | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private crons: Cron[] = [];
  private watcher: FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;
  private subscribing = false; // set by init once stored events replayed: a trigger may start runs from then on

  constructor(o: FlowdOptions) {
    this.o = o;
    this.home = o.home;
    this.agterm = o.agterm;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.error(`[flowd] ${m}`));
    this.store = new Store(o.statePath);
    this.plugins = new PluginHost({
      dirs: o.pluginDirs,
      config: readPluginConfig(o.home, this.log),
      sink: (e) => { void this.submit(e); },
      log: this.log,
      retryBaseMs: o.retryBaseMs,
    });
  }

  async init(): Promise<void> {
    mkdirSync(this.home, { recursive: true });
    await this.plugins.load();
    this.reloadDefs();
    await this.reconcileSessions();
    this.plugins.startAll();
    for (const e of this.store.unprocessed()) void this.enqueue(() => this.process(e.id));
    // Behind the replayed events, so a report stored before a crash wins, and before any watch is
    // armed, so an action a fresh event starts is not mistaken for one the restart cut off.
    void this.enqueue(async () => {
      for (const run of this.store.openRuns()) {
        const cur = this.currentEntry(run);
        if (cur?.kind === "action" && (cur.do?.includes(".") || cur.sh !== undefined) && run.entries[cur.id]?.status === "active") {
          // its promise (or its shell) died with the old process: fail the entry so on_fail decides
          const note = cur.sh !== undefined ? "flowd restarted while the command ran" : "flowd restarted while the action ran";
          await this.process(this.store.addEvent({ type: "entry.report", data: { run: run.id, entry: cur.id, outcome: "failed", note, by: "system" }, source: "flowd" }, this.now()));
        }
      }
      for (const run of this.store.openRuns()) this.rearm(run);
      this.grantHolds();
      this.subscribing = true;
      this.syncSubscriptions();
    });
    const tickMs = this.o.tickMs ?? 5_000;
    const flushMs = this.o.flushMs ?? 1_000;
    if (tickMs > 0) this.timers.push(setInterval(() => { void this.tickNow(); }, tickMs));
    if (flushMs > 0) this.timers.push(setInterval(() => { void this.flush(); }, flushMs));
    const titleMs = this.o.titleMs ?? 600_000;
    if (titleMs > 0) {
      this.timers.push(setInterval(() => { void this.refreshTitles(); }, titleMs));
      this.background(this.refreshTitles()); // runs that got their PR while flowd was down
    }
    if (this.o.watchDefs !== false) this.watcher = fsWatch(this.home, { recursive: true }, () => this.scheduleReload());
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const c of this.children) c.kill(); // a restart fails what was cut off: see init
    for (const t of this.timers) clearInterval(t);
    for (const c of this.crons) c.stop();
    clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.plugins.stopAll();
    await this.flushRun;
    await this.idle();
    this.store.close();
  }

  /** Resolves once every queued event has been processed. */
  async idle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.chain;
      await seen;
      await Promise.all([...this.side]);
    } while (seen !== this.chain || this.side.size > 0);
  }

  private background(p: Promise<unknown>): void {
    const tracked = p.catch((e) => this.log(msg(e))).finally(() => this.side.delete(tracked));
    this.side.add(tracked);
  }

  on(fn: (what: "runs" | "defs") => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private changed(what: "runs" | "defs"): void {
    for (const fn of this.listeners) fn(what);
  }

  defCtx(): DefCtx {
    return { steps: this.defs.steps, eventTypes: this.plugins.eventTypes(), actionNames: this.plugins.actionNames() };
  }

  /** Where a process's plugins run: its cwd, ~ expanded. */
  private cwdOf(process: string): string {
    return expandHome(this.defs.processes[process]?.cwd ?? "~");
  }

  private currentEntry(run: RunState) {
    return run.current ? this.defs.processes[run.process]?.entries.find((x) => x.id === run.current) : undefined;
  }

  reloadDefs(): void {
    const before = this.defs;
    this.defs = loadDefs(this.home, this.plugins.eventTypes(), this.plugins.actionNames());
    // A waiting entry whose wait_for was edited gets its watch armed again from the new definition.
    // Unchanged ones keep theirs: a fresh watch can miss what happened since the last poll (gh.review
    // takes its baseline at start). The first load arms nothing; init does that once events replayed.
    if (this.loaded) {
      for (const run of this.store.openRuns()) {
        if (!run.current || run.entries[run.current]?.status !== "waiting") continue;
        const was = before.processes[run.process]?.entries.find((x) => x.id === run.current)?.waitFor;
        if (JSON.stringify(was) === JSON.stringify(this.currentEntry(run)?.waitFor)) continue;
        this.plugins.unwatch(run.id, run.current);
        this.rearm(run);
      }
    }
    if (this.loaded) void this.enqueue(async () => this.grantHolds());
    this.loaded = true;
    for (const c of this.crons) c.stop();
    this.crons = [];
    for (const p of Object.values(this.defs.processes)) {
      for (const t of p.triggers) {
        if (!t.cron) continue;
        this.crons.push(new Cron(t.cron, () => { void this.submit({ type: "run.start", data: { process: p.name, trigger: "cron" }, source: "cron" }); }));
      }
    }
    if (this.subscribing) this.syncSubscriptions();
    this.changed("defs");
  }

  /**
   * Every on: trigger for a plugin event is a standing subscription through the plugin's watch().
   * Identical ones (type, cwd, with) are shared; unchanged ones keep their plugin state (a baseline).
   */
  private syncSubscriptions(): void {
    const wanted = new Map<string, Watch>();
    for (const p of Object.values(this.defs.processes)) {
      for (const t of p.triggers) {
        if (!t.on || !this.plugins.loaded.has(t.on.split(".")[0])) continue; // flow.* and signal.* need no plugin
        const w: Watch = { type: t.on, with: t.with, cwd: expandHome(p.cwd), vars: {}, processes: [p.name] };
        const k = subscriptionKey(w);
        const same = wanted.get(k);
        if (same) same.processes!.push(p.name);
        else wanted.set(k, w);
      }
    }
    for (const k of this.plugins.subscriptionKeys()) if (!wanted.has(k)) this.plugins.unsubscribe(k);
    for (const [k, w] of wanted) {
      const have = this.plugins.subscription(k);
      if (have) have.processes = w.processes; // the same subscription, perhaps asked for by other processes now
      else this.plugins.watch(w);
    }
  }

  /** "<type>: <error>" for each failing trigger subscription this process asked for. */
  triggerErrors(process: string): string[] {
    return this.plugins.status().flatMap((p) => p.watches)
      .filter((w) => w.run === null && w.error && w.processes?.includes(process))
      .map((w) => `${w.type}: ${w.error}`);
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.reloadDefs(), 300);
  }

  private async reconcileSessions(): Promise<void> {
    let live;
    try {
      live = await this.agterm.tree();
    } catch (e) {
      this.log(`agterm tree: ${msg(e)}`);
      return;
    }
    const ids = new Set(live.map((s) => s.id));
    for (const s of live) {
      // active before the restart and cleared now: the turn ended while flowd was down
      // (agterm resets completed to idle on the user's first key), so it counts as completed
      const was = this.store.sessionStatus(s.id);
      const shown = s.status && s.status !== "idle" ? s.status : undefined; // agterm omits idle
      const now = shown ?? (was === "active" ? "completed" : "idle");
      this.store.setSessionStatus(s.id, now, this.now());
    }
    for (const run of this.store.openRuns()) {
      for (const session of new Set(Object.values(run.roles))) {
        if (!session) continue;
        // a turn that ended while flowd was down must still start its reminder clock
        if (ids.has(session)) void this.submit({ type: "agterm.status", data: { session, status: this.store.sessionStatus(session) }, source: "flowd" });
        else void this.submit({ type: "agterm.closed", data: { session }, source: "flowd" });
      }
    }
  }

  private rearm(run: RunState): void {
    const cur = run.current ? this.defs.processes[run.process]?.entries.find((x) => x.id === run.current) : undefined;
    if (!cur?.waitFor || run.entries[cur.id]?.status !== "waiting" || run.entries[cur.id]?.queued) return;
    let w: Dict;
    try {
      w = renderWith(cur.waitFor.with, run);
    } catch (e) {
      void this.submit({ type: "run.halt", run: run.id, data: { reason: `${cur.id}: ${msg(e)}` }, source: "flowd" });
      return;
    }
    const woke = run.entries[cur.id]?.woke;
    const previous = woke?.type === cur.waitFor.on ? woke : undefined;
    this.plugins.watch({ run: run.id, entry: cur.id, type: cur.waitFor.on, with: w, cwd: this.cwdOf(run.process), vars: run.vars, ...(previous ? { previous } : {}) });
  }

  submit(e: FlowEvent): Promise<Result> {
    const id = this.store.addEvent({ ...e, data: e.data ?? {} }, this.now());
    return this.enqueue(() => this.process(id));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async process(id: number): Promise<Result> {
    const e = this.store.event(id);
    if (!e || e.processed) return {};
    let result: Result;
    try {
      result = await this.handle(e);
    } catch (err) {
      this.log(`event ${id} ${e.type}: ${msg(err)}`);
      result = { error: msg(err) };
    }
    this.store.markProcessed(id);
    this.changed("runs");
    return result;
  }

  private async handle(e: StoredEvent): Promise<Result> {
    const d = e.data as Record<string, unknown>;
    const run = e.run ?? "";
    const entry = e.entry ?? "";
    switch (e.type) {
      case "run.start":
        return this.startRun(String(d.process ?? ""), stringVars(d.bind), str(d.trigger), undefined, stringVars(d.vars));
      case "agterm.status":
      case "agterm.closed": {
        const session = String(d.session ?? "");
        if (!session) return { error: "no session" };
        const status = (e.type === "agterm.closed" ? "closed" : AGTERM_STATUSES.has(String(d.status)) ? d.status : "idle") as SessionStatus;
        this.store.setSessionStatus(session, status, this.now());
        for (const r of this.store.openRuns()) {
          if (Object.values(r.roles).includes(session)) await this.apply(r.id, { kind: "session", session, status });
        }
        if (status !== "active") void this.flush();
        return {};
      }
      case "claude.compacted": {
        const session = String(d.session ?? "");
        for (const r of this.store.openRuns()) {
          if (Object.values(r.roles).includes(session)) await this.apply(r.id, { kind: "compacted", session });
        }
        return {};
      }
      case "entry.report": {
        const t = this.resolveTarget(d);
        if ("error" in t) return t;
        const outcome = d.outcome === "done" || d.outcome === "failed" ? (d.outcome as "done" | "failed") : null;
        if (!outcome) return { error: "outcome must be done or failed" };
        const by = (d.by === "human" || d.by === "system" ? d.by : "agent") as "agent" | "human" | "system";
        return this.apply(t.run, { kind: "report", entry: t.entry, outcome, note: str(d.note), evidence: str(d.evidence), by });
      }
      case "entry.wait": {
        const t = this.resolveTarget(d);
        if ("error" in t) return t;
        const run = this.store.getRun(t.run);
        const role = run ? this.currentEntry(run)?.role : undefined;
        const bound = run && role ? run.roles[role] : null;
        // Mid-turn (active, or blocked on a prompt) the wait parks on that turn's end, whoever sent it;
        // an agent already idle has no turn end coming, so the wait parks at once. Unknown status:
        // a call from the agent's own session is mid-turn by definition.
        const st = bound ? this.store.sessionStatus(bound) : null;
        const sessionActive = st === "active" || st === "blocked" || (st === null && Boolean(bound) && d.session === bound);
        return this.apply(t.run, { kind: "wait", entry: t.entry, note: String(d.note ?? ""), human: d.human === true, sessionActive });
      }
      case "entry.delivered":
        return this.apply(run, { kind: "delivered", entry });
      case "entry.skip":
        return this.apply(run, { kind: "skip", entry, note: String(d.note ?? "") });
      case "entry.goto":
        return this.apply(run, { kind: "goto", entry });
      case "entry.retry":
        return this.apply(run, { kind: "retry", entry });
      case "run.pause":
        return this.apply(run, { kind: "pause" });
      case "run.resume": {
        const r = await this.apply(run, { kind: "resume" });
        void this.flush();
        return r;
      }
      case "run.stop":
        return this.apply(run, { kind: "stop" });
      case "run.set":
        return this.apply(run, { kind: "set", vars: stringVars(d.vars) });
      case "role.bind": {
        const session = str(d.session) ?? null;
        const by = d.by === "spawn" ? "spawn" : "human";
        if (session && by === "human") {
          const taken = this.store.runBySession(session);
          if (taken && taken.run.id !== run) return { error: `session ${session} is already bound to ${taken.run.id}` };
        }
        return this.apply(run, { kind: "bind", role: String(d.role ?? ""), session, by });
      }
      case "role.respawn":
        return this.apply(run, { kind: "respawn", role: String(d.role ?? "") });
      case "role.failed":
      case "run.halt":
        return this.apply(run, { kind: "halt", reason: String(d.reason ?? "role failed") });
      case "entry.start-blocked":
        return this.apply(run, { kind: "start-blocked", entry, reason: String(d.reason ?? "") });
    }
    return this.route(e);
  }

  private async route(e: StoredEvent): Promise<Result> {
    const ev: FlowEvent = { id: e.id, type: e.type, outcome: e.outcome, data: e.data, run: e.run, entry: e.entry, source: e.source };
    if (e.run) return this.apply(e.run, { kind: "event", event: ev });
    if (e.subscription) {
      // From a trigger subscription: it starts only the processes whose trigger it serves (same type,
      // cwd and with, and a matching where), and wakes no wait, since waits have their own watches.
      for (const name of this.plugins.subscription(e.subscription)?.processes ?? []) {
        const p = this.defs.processes[name];
        for (const t of p?.triggers ?? []) {
          if (t.on !== e.type || !matches(t.where, e.data)) continue;
          if (subscriptionKey({ type: t.on, cwd: expandHome(p!.cwd), with: t.with }) !== e.subscription) continue;
          await this.startRun(name, {}, e.type, ev);
        }
      }
      return {};
    }
    for (const run of this.store.openRuns()) {
      const cur = run.current ? this.defs.processes[run.process]?.entries.find((x) => x.id === run.current) : undefined;
      if (cur?.waitFor?.on === e.type && run.entries[cur.id]?.status === "waiting" && matches(cur.waitFor.where, e.data)) {
        await this.apply(run.id, { kind: "event", event: ev });
      }
    }
    for (const p of Object.values(this.defs.processes)) {
      for (const t of p.triggers) {
        if (t.on === e.type && matches(t.where, e.data)) await this.startRun(p.name, {}, e.type, ev);
      }
    }
    return {};
  }

  resolveTarget(d: Dict): { run: string; entry: string } | { error: string } {
    if (typeof d.run === "string" && d.run && typeof d.entry === "string" && d.entry) return { run: d.run, entry: d.entry };
    const session = typeof d.session === "string" ? d.session : "";
    if (!session) return { error: "no session: run this inside a flow session, or pass --run and --step" };
    const hit = this.store.runBySession(session);
    if (!hit) return { error: "no open run is bound to this session" };
    const cur = hit.run.current ? this.defs.processes[hit.run.process]?.entries.find((x) => x.id === hit.run.current) : undefined;
    if (!cur || cur.role !== hit.role) {
      return { error: `no active step for this session (${hit.run.id} is at ${hit.run.current ?? "nothing"}${cur?.role ? `, role ${cur.role}` : ""})` };
    }
    return { run: hit.run.id, entry: cur.id };
  }

  private async startRun(name: string, bind: Record<string, string>, trigger?: string, ev?: FlowEvent, vars: Record<string, string> = {}): Promise<Result> {
    const p = this.defs.processes[name];
    if (!p) {
      const why = this.defs.invalid[`process:${name}`];
      return { error: `no valid process ${name}${why ? `: ${why.join("; ")}` : ""}` };
    }
    const open = this.store.openRuns().filter((r) => r.process === name).length;
    if (open >= p.maxRuns) {
      if (trigger && trigger !== "flow.trigger.skipped") void this.submit({ type: "flow.trigger.skipped", data: { process: name, trigger }, source: "flow" });
      return { error: `${name} already has ${open} open run(s) (max_runs ${p.maxRuns})` };
    }
    for (const [role, session] of Object.entries(bind)) {
      if (!p.roles[role]) return { error: `${name} has no role ${role}` };
      const taken = this.store.runBySession(session);
      if (taken) return { error: `session ${session} is already bound to ${taken.run.id}` };
    }
    const n = this.store.nextRunNumber(name);
    const run = newRun(`${name}#${n}`, p, bind);
    this.store.createRun(run, n, this.now());
    return this.apply(run.id, { kind: "start", vars, event: ev ? { type: ev.type, outcome: ev.outcome, data: ev.data, source: ev.source } : undefined });
  }

  private async apply(runId: string, input: Input): Promise<Result> {
    const run = this.store.getRun(runId);
    if (!run) return { error: `no run ${runId}` };
    const res = step(run, input, this.ctxFor(run));
    if (res.error) return { error: res.error, run: runId };
    this.commit(res);
    this.grantHolds();
    if (res.run.vars.pr && res.run.vars.pr !== run.vars.pr) this.background(this.refreshTitle(runId));
    return { run: runId };
  }

  /** Re-reads every open run's title from its PR: a renamed PR renames the run. */
  refreshTitles(): Promise<void> {
    return Promise.all(this.store.openRuns().filter((r) => r.vars.pr).map((r) => this.refreshTitle(r.id))).then(() => undefined);
  }

  private async refreshTitle(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run?.vars.pr || this.closing) return;
    const title = await this.plugins.titleOf(run.vars, this.cwdOf(run.process));
    // the PR may have changed while gh answered
    if (title && title !== run.vars.title && this.store.getRun(runId)?.vars.pr === run.vars.pr) {
      await this.submit({ type: "run.set", run: runId, data: { vars: { title } }, source: "flowd" });
    }
  }

  private ctxFor(run: RunState) {
    return { process: this.defs.processes[run.process], defs: this.defs, now: this.now(), holders: this.holders() };
  }

  /** Each hold name and the open run standing on an entry that holds it (not queued for it). */
  holders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const run of this.store.openRuns()) {
      const hold = this.currentEntry(run)?.hold;
      if (hold && !run.entries[run.current!]?.queued) out[hold] = run.id;
    }
    return out;
  }

  /** Hands every free hold to the running run that queued for it first. */
  private grantHolds(): void {
    const held = this.holders();
    const queued = this.store.openRuns()
      .filter((r) => r.status === "running" && r.current && r.entries[r.current]?.queued)
      .sort((a, b) => a.entries[a.current!].queued!.since - b.entries[b.current!].queued!.since);
    for (const run of queued) {
      const hold = run.entries[run.current!].queued!.hold;
      if (held[hold]) continue;
      const res = step(run, { kind: "hold-free" }, { ...this.ctxFor(run), holders: held });
      if (res.error) continue;
      this.commit(res);
      held[hold] = run.id;
      this.changed("runs");
    }
  }

  private commit(res: StepResult): void {
    const runId = res.run.id;
    const emitted: number[] = [];
    this.store.tx(() => {
      this.store.saveRun(res.run, this.now());
      for (const a of res.actions) {
        if (a.kind === "deliver") this.store.enqueue(runId, a.role, a.text, a.entry ?? null, this.now());
        if (a.kind === "emit") emitted.push(this.store.addEvent(a.event, this.now()));
      }
      if (res.run.status === "stopped") this.store.dropOutbox(runId);
    });
    for (const a of res.actions) {
      if (a.kind === "watch") this.plugins.watch({ run: runId, entry: a.entry, type: a.waitFor.on, with: a.waitFor.with, cwd: this.cwdOf(res.run.process), vars: res.run.vars, ...(a.previous ? { previous: a.previous } : {}) });
      else if (a.kind === "unwatch") this.plugins.unwatch(runId, a.entry);
      else if (a.kind === "plugin-action") void this.runAction(runId, a.entry, a.name, a.with);
      else if (a.kind === "shell") this.background(this.runShell(runId, a.entry, a.command, a.cwd, a.env, a.timeoutMs));
    }
    for (const id of emitted) void this.enqueue(() => this.process(id));
    if (res.actions.some((a) => a.kind === "deliver")) void this.flush();
  }

  private async runAction(run: string, entry: string, name: string, args: Dict): Promise<void> {
    let outcome: "done" | "failed" = "done";
    let note: string | undefined;
    try {
      await this.plugins.runAction(name, args);
    } catch (e) {
      outcome = "failed";
      note = msg(e);
    }
    await this.submit({ type: "entry.report", data: { run, entry, outcome, note, by: "system" }, source: "flowd" });
  }

  tickNow(): Promise<void> {
    return this.enqueue(async () => {
      for (const run of this.store.openRuns()) {
        if (run.status !== "running") continue;
        const res = step(run, { kind: "tick" }, this.ctxFor(run));
        if (res.error) continue;
        if (res.actions.length || JSON.stringify(res.run) !== JSON.stringify(run)) {
          this.commit(res);
          this.changed("runs");
        }
      }
    });
  }

  flush(): Promise<void> {
    if (!this.flushRun) this.flushRun = this.doFlush().finally(() => { this.flushRun = undefined; });
    return this.flushRun;
  }

  private async doFlush(): Promise<void> {
    for (const row of this.store.pendingOutbox()) {
      const run = this.store.getRun(row.run_id);
      // a done run still types its last session action (a final type or clear) into a live session
      const finished = run && TERMINAL.includes(run.status) && (run.status === "stopped" || row.entry_id || !run.roles[row.role]);
      if (!run || finished) { this.store.markSent(row.id, this.now()); continue; }
      if (row.entry_id && (run.current !== row.entry_id || run.entries[row.entry_id]?.status !== "active")) {
        this.store.markSent(row.id, this.now()); // stale: the step moved on before its line went out
        continue;
      }
      if (run.status === "paused" || run.status === "needs-human") continue; // held, never spawned for
      const session = run.roles[row.role];
      if (!session) { await this.spawnFor(run, row); continue; }
      const busy = this.store.sessionStatus(session);
      if (busy === "active" || busy === "blocked") continue; // mid-turn, or at a permission prompt
      if (this.now() - (this.lastTyped.get(session) ?? -Infinity) < (this.o.gapMs ?? 2_000)) continue;
      if (await this.userInSession(session)) continue; // the line stays queued; retried on the next flush
      try {
        await this.agterm.type(session, row.text);
        this.store.markSent(row.id, this.now());
        this.lastTyped.set(session, this.now());
        if (row.entry_id) void this.submit({ type: "entry.delivered", run: row.run_id, entry: row.entry_id, data: {}, source: "flowd" });
      } catch (e) {
        this.log(`type into ${session}: ${msg(e)}`);
        if (this.store.bumpOutbox(row.id) >= 3) {
          this.store.markSent(row.id, this.now());
          await this.submit({ type: "agterm.closed", data: { session, reason: msg(e) }, source: "flowd" });
        }
      }
    }
  }

  /** A session in that workspace with that name that no open run has: one a lost spawn opened. */
  private async unboundSession(workspace: string, name: string): Promise<string | undefined> {
    try {
      return (await this.agterm.tree()).find((s) => s.workspace === workspace && s.name === name && !this.store.runBySession(s.id))?.id;
    } catch {
      return undefined; // agterm unreachable: the spawn below fails and is retried
    }
  }

  private async spawnFor(run: RunState, row: OutboxRow): Promise<void> {
    const key = `${run.id}\u0000${row.role}`;
    if (this.spawning.has(key)) return;
    const p = this.defs.processes[run.process];
    const role = p?.roles[row.role];
    if (!p || !role) {
      this.store.markSent(row.id, this.now());
      await this.submit({ type: "role.failed", run: run.id, data: { role: row.role, reason: `role ${row.role} is not declared in ${run.process}` }, source: "flowd" });
      return;
    }
    this.spawning.add(key);
    let attempts = row.attempts + 1;
    try {
      const cwd = expandHome(renderTemplate(role.cwd ?? p.cwd, renderData(run)));
      const name = renderTemplate(role.name ?? "{{run.id}} {{role}}", { ...renderData(run), role: row.role });
      const workspace = p.workspace ?? run.process;
      // an earlier attempt may have opened the session and lost the answer (flowd died, the socket
      // broke): take that session rather than start the agent twice
      const opened = row.attempts > 0 ? await this.unboundSession(workspace, name) : undefined;
      attempts = this.store.bumpOutbox(row.id); // counted before spawning, so a crash right after is known
      const session = opened ?? await this.agterm.spawn({ cwd, command: spawnCommand(role.spawn, row.text), workspace, name });
      this.store.markSent(row.id, this.now());
      this.lastTyped.set(session, this.now() + (this.o.spawnGraceMs ?? 15_000));
      await this.submit({ type: "role.bind", run: run.id, data: { role: row.role, session, by: "spawn" }, source: "flowd" });
      if (row.entry_id) await this.submit({ type: "entry.delivered", run: run.id, entry: row.entry_id, data: {}, source: "flowd" });
      // Claude stops at its folder-trust dialog before it reads the first line: answer it,
      // beside delivery so other sessions are not held up
      if (row.entry_id && basename(role.spawn.trim().split(/\s+/)[0]) === "claude" && !this.claudeTrusts(cwd)) {
        this.background(this.answerTrust(run.id, row.entry_id, session, cwd));
      }
    } catch (e) {
      this.log(`spawn ${run.id} ${row.role}: ${msg(e)}`);
      if (attempts >= 3) {
        this.store.markSent(row.id, this.now());
        await this.submit({ type: "role.failed", run: run.id, data: { role: row.role, reason: `spawn failed: ${msg(e)}` }, source: "flowd" });
      }
    } finally {
      this.spawning.delete(key);
    }
  }

  /**
   * The user is typing in the session (the caret is past the prompt), or an overlay is open in it:
   * typing now would land on top. The caret, not the screen: Claude Code draws a greyed suggestion
   * in an empty input box that the screen text cannot tell from typed text.
   */
  private async userInSession(session: string): Promise<boolean> {
    try {
      const info = (await this.agterm.tree()).find((s) => s.id === session);
      if (info?.overlay) return true;
      if (!info?.surface) return false;
      return (await this.agterm.cursorColumn(info.surface)) > EMPTY_INPUT_COLUMN;
    } catch {
      return false; // cannot tell: deliver as before
    }
  }

  /**
   * The process spawned an agent into this folder, so it trusts it: select "Yes, I trust this
   * folder" (Down, then Enter once the marker is on it). Never writes ~/.claude.json.
   */
  private async answerTrust(run: string, entry: string, session: string, cwd: string): Promise<void> {
    const pause = () => new Promise((r) => setTimeout(r, this.o.trustPollMs ?? 1_000));
    const yesSelected = (screen: string) => /❯\s*(\d+\.\s*)?Yes, I trust this folder/.test(screen);
    const stop = (why: string) => this.submit({
      type: "entry.start-blocked", run, entry, source: "flowd",
      data: { reason: `${entry}: Claude Code asks whether to trust ${cwd} and flowd could not ${why} — open the session and choose "Yes, I trust this folder"` },
    });
    try {
      let screen = "";
      for (let i = 0; i < 30 && !screen.includes("Yes, I trust this folder"); i++) {
        if (i) await pause();
        screen = await this.agterm.text(session);
      }
      if (!screen.includes("Yes, I trust this folder")) return; // no dialog: the start watchdog covers any other hang
      if (!yesSelected(screen)) {
        await this.agterm.press(session, "\x1b[B");
        await pause();
        screen = await this.agterm.text(session);
      }
      if (!yesSelected(screen)) {
        await stop('select "Yes"');
        return;
      }
      await this.agterm.press(session, "\r");
      this.log(`answered Claude's folder-trust dialog for ${cwd}`);
    } catch (e) {
      await stop(`answer it (${msg(e)})`);
    }
  }

  /** A shell entry: run the command as written, the run in its environment; report how it ended. */
  private runShell(run: string, entry: string, command: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<void> {
    const [bin, ...args] = this.o.shell ?? ["/bin/zsh", "-lc"];
    return new Promise((resolve) => {
      const child = execFile(bin, [...args, command], { cwd: expandHome(cwd), env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          this.children.delete(child);
          if (this.closing) return resolve(); // cut off by shutdown: the next start fails the entry
          const out = String(stdout).trim();
          let outcome: "done" | "failed" = "done";
          let note = out.split("\n").pop() || "exit 0";
          if (err) {
            outcome = "failed";
            const e = err as { killed?: boolean; signal?: string | null; code?: unknown; message: string };
            note = e.killed && e.signal ? `timed out after ${formatDuration(timeoutMs)}`
              : `exit ${typeof e.code === "number" ? e.code : 1}: ${(String(stderr).trim() || out || e.message).slice(-500)}`;
          }
          resolve(this.submit({ type: "entry.report", data: { run, entry, outcome, note: note.slice(0, 500), by: "system" }, source: "flowd" }).then(() => undefined));
        });
      this.children.add(child);
    });
  }

  /** Read-only. No config, or one that cannot be read, is no reason to stop a run. */
  private claudeTrusts(cwd: string): boolean {
    const path = this.o.claudeConfig ?? join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
    let projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    try {
      projects = JSON.parse(readFileSync(path, "utf8")).projects ?? {};
    } catch {
      return true;
    }
    let real = cwd;
    try {
      real = realpathSync(cwd);
    } catch {
      // a folder that does not exist yet: compare the path as written
    }
    return [cwd, real].some((p) => projects[p]?.hasTrustDialogAccepted === true);
  }

  show(q: { session?: string; run?: string; entry?: string }): { text: string } | { error: string } {
    const t = this.resolveTarget(q as Dict);
    if ("error" in t) return t;
    const run = this.store.getRun(t.run);
    const entry = run ? this.defs.processes[run.process]?.entries.find((x) => x.id === t.entry) : undefined;
    if (!run || !entry) return { error: `no step ${t.entry} in ${t.run}` };
    if (entry.kind !== "agent" && entry.kind !== "human") return { error: `${entry.id} is a ${entry.kind} step; it has no prompt` };
    let prompt: string;
    try {
      prompt = renderPrompt(run, entry, this.defs);
    } catch (e) {
      return { error: msg(e) };
    }
    const s = run.entries[entry.id];
    const lines = [`flow · ${run.id} · iteration ${run.iteration} · step ${entry.id} (role ${entry.role}) · ${s?.status ?? "pending"}`];
    if (s?.wait) lines.push(`waiting since ${new Date(s.wait.since).toISOString()}: ${s.wait.note}`);
    if (s?.event) lines.push(`woken by: ${s.event.type}${s.event.outcome ? ` ${s.event.outcome}` : ""} ${JSON.stringify(s.event.data)}`);
    const vars = Object.entries(run.vars);
    if (vars.length) lines.push(`vars: ${vars.map(([k, v]) => `${k}=${v}`).join("  ")}`);
    lines.push("", prompt, "", entry.kind === "human"
      ? `Close it in the UI or with \`flow done --human --run ${shq(run.id)} --step ${entry.id}\``
      : "Report: `flow done [--note …] [--evidence URL]` · `flow failed --note …` · `flow set key=value` · ending your turn to wait on purpose: `flow wait --note …`");
    return { text: lines.join("\n") };
  }

  preview(body: string, runId?: string): { text: string } | { error: string } {
    const run = runId ? this.store.getRun(runId) : null;
    const data = run ? renderData(run, run.current ? run.entries[run.current]?.event : undefined) : {};
    try {
      return { text: renderTemplate(body, data) };
    } catch (e) {
      return { error: msg(e) };
    }
  }

  runSummary(run: RunState): RunSummary {
    const p = this.defs.processes[run.process];
    const cur = run.current ? p?.entries.find((x) => x.id === run.current) : undefined;
    const s = cur ? run.entries[cur.id] : undefined;
    const times = this.store.runTimes(run.id);
    return {
      id: run.id, process: run.process, iteration: run.iteration, status: run.status, reason: run.reason ?? null,
      current: run.current, currentStatus: s?.status ?? null, currentKind: cur?.kind ?? null,
      waitingOn: s?.status === "waiting" && !s.queued ? cur?.waitFor?.on ?? null : null,
      roles: run.roles, vars: run.vars,
      needsYou: run.status === "needs-human" || (cur?.kind === "human" && (s?.status === "active" || s?.status === "waiting")) || Boolean(s?.wait?.human),
      agentWait: s?.wait ? { note: s.wait.note, human: s.wait.human, since: s.wait.since } : null,
      waitUntil: cur?.kind === "delay" && s?.status === "waiting" && s.startedAt !== undefined && !s.queued ? s.startedAt + cur.delayMs! : null,
      heldBy: s?.queued ? { hold: s.queued.hold, run: this.holders()[s.queued.hold] ?? null } : null,
      created: times?.created ?? 0, updated: times?.updated ?? 0,
      plan: (p?.entries ?? []).map((e) => {
        const st = run.entries[e.id];
        return {
          id: e.id, kind: e.kind, role: e.role ?? null, detour: e.detour, waitFor: e.waitFor?.on ?? null,
          status: st?.status ?? "pending", step: e.step ?? null,
          summary: e.step ? this.defs.steps[e.step]?.summary ?? null : null, do: e.do ?? null,
          startedAt: st?.startedAt ?? null, note: st?.note ?? null, onFail: e.onFail, after: e.after ?? null,
          waitMs: e.delayMs ?? null, sh: e.sh ?? null,
        };
      }),
    };
  }

  runSummaries(all = false): RunSummary[] {
    return (all ? this.store.listRuns() : this.store.openRuns()).map((r) => this.runSummary(r));
  }

  runDetail(id: string) {
    const run = this.store.getRun(id);
    if (!run) return null;
    const sessions: Record<string, string | null> = {};
    for (const s of Object.values(run.roles)) if (s) sessions[s] = this.store.sessionStatus(s);
    return { ...this.runSummary(run), entries: run.entries, events: this.store.runEvents(id), sessions };
  }
}
