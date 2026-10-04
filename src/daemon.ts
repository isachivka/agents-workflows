import { existsSync, mkdirSync, readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Cron } from "croner";
import { loadDefs, type DefCtx } from "./defs.ts";
import { matches, newRun, renderData, renderPrompt, step } from "./engine.ts";
import { expandHome, shq, spawnCommand, type Agterm } from "./agterm.ts";
import { PluginHost, msg } from "./plugins.ts";
import { Store, type OutboxRow, type StoredEvent } from "./store.ts";
import { renderTemplate } from "./template.ts";
import { TERMINAL } from "./types.ts";
import type { Defs, Dict, FlowEvent, Input, RunState, SessionStatus, StepResult } from "./types.ts";

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
}

export interface Result { error?: string; run?: string }

export interface RunSummary {
  id: string; process: string; iteration: number; status: string; reason: string | null;
  current: string | null; currentStatus: string | null; currentKind: string | null; waitingOn: string | null;
  roles: Record<string, string | null>; vars: Record<string, string>; needsYou: boolean;
  plan: { id: string; kind: string; role: string | null; detour: boolean; waitFor: string | null; status: string }[];
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
  private listeners = new Set<(what: "runs" | "defs") => void>();
  private lastTyped = new Map<string, number>();
  private spawning = new Set<string>();
  private flushRun: Promise<void> | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private crons: Cron[] = [];
  private watcher: FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

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
    for (const run of this.store.openRuns()) this.rearm(run);
    for (const e of this.store.unprocessed()) void this.enqueue(() => this.process(e.id));
    const tickMs = this.o.tickMs ?? 5_000;
    const flushMs = this.o.flushMs ?? 1_000;
    if (tickMs > 0) this.timers.push(setInterval(() => { void this.tickNow(); }, tickMs));
    if (flushMs > 0) this.timers.push(setInterval(() => { void this.flush(); }, flushMs));
    if (this.o.watchDefs !== false) this.watcher = fsWatch(this.home, { recursive: true }, () => this.scheduleReload());
  }

  async close(): Promise<void> {
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
    } while (seen !== this.chain);
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

  reloadDefs(): void {
    this.defs = loadDefs(this.home, this.plugins.eventTypes(), this.plugins.actionNames());
    for (const c of this.crons) c.stop();
    this.crons = [];
    for (const p of Object.values(this.defs.processes)) {
      for (const t of p.triggers) {
        if (!t.cron) continue;
        this.crons.push(new Cron(t.cron, () => { void this.submit({ type: "run.start", data: { process: p.name, trigger: "cron" }, source: "cron" }); }));
      }
    }
    this.changed("defs");
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
    for (const s of live) this.store.setSessionStatus(s.id, s.status ?? "idle", this.now());
    for (const run of this.store.openRuns()) {
      for (const session of new Set(Object.values(run.roles))) {
        if (session && !ids.has(session)) void this.submit({ type: "agterm.closed", data: { session }, source: "flowd" });
      }
    }
  }

  private rearm(run: RunState): void {
    const cur = run.current ? this.defs.processes[run.process]?.entries.find((x) => x.id === run.current) : undefined;
    if (!cur?.waitFor || run.entries[cur.id]?.status !== "waiting") return;
    let w: Dict = {};
    try {
      w = Object.fromEntries(Object.entries(cur.waitFor.with).map(([k, v]) => [k, typeof v === "string" ? renderTemplate(v, renderData(run)) : v]));
    } catch (e) {
      this.log(`re-arm ${run.id} ${cur.id}: ${msg(e)}`);
    }
    this.plugins.watch({ run: run.id, entry: cur.id, type: cur.waitFor.on, with: w, vars: run.vars });
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
        return this.startRun(String(d.process ?? ""), stringVars(d.bind), str(d.trigger));
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
        return this.apply(run, { kind: "halt", reason: String(d.reason ?? "role failed") });
    }
    return this.route(e);
  }

  private async route(e: StoredEvent): Promise<Result> {
    const ev: FlowEvent = { id: e.id, type: e.type, outcome: e.outcome, data: e.data, run: e.run, entry: e.entry, source: e.source };
    if (e.run) return this.apply(e.run, { kind: "event", event: ev });
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

  private async startRun(name: string, bind: Record<string, string>, trigger?: string, ev?: FlowEvent): Promise<Result> {
    const p = this.defs.processes[name];
    if (!p) {
      const why = this.defs.invalid[`process:${name}`];
      return { error: `no valid process ${name}${why ? `: ${why.join("; ")}` : ""}` };
    }
    const open = this.store.openRuns().filter((r) => r.process === name).length;
    if (open >= p.maxRuns) {
      if (trigger) void this.submit({ type: "flow.trigger.skipped", data: { process: name, trigger }, source: "flow" });
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
    return this.apply(run.id, { kind: "start", event: ev ? { type: ev.type, outcome: ev.outcome, data: ev.data, source: ev.source } : undefined });
  }

  private async apply(runId: string, input: Input): Promise<Result> {
    const run = this.store.getRun(runId);
    if (!run) return { error: `no run ${runId}` };
    const res = step(run, input, { process: this.defs.processes[run.process], defs: this.defs, now: this.now() });
    if (res.error) return { error: res.error, run: runId };
    this.commit(res);
    return { run: runId };
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
      if (TERMINAL.includes(res.run.status)) this.store.dropOutbox(runId);
    });
    for (const a of res.actions) {
      if (a.kind === "watch") this.plugins.watch({ run: runId, entry: a.entry, type: a.waitFor.on, with: a.waitFor.with, vars: res.run.vars });
      else if (a.kind === "unwatch") this.plugins.unwatch(runId, a.entry);
      else if (a.kind === "plugin-action") void this.runAction(runId, a.entry, a.name, a.with);
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
        const res = step(run, { kind: "tick" }, { process: this.defs.processes[run.process], defs: this.defs, now: this.now() });
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
      if (!run || TERMINAL.includes(run.status)) { this.store.markSent(row.id, this.now()); continue; }
      if (row.entry_id && (run.current !== row.entry_id || run.entries[row.entry_id]?.status !== "active")) {
        this.store.markSent(row.id, this.now()); // stale: the step moved on before its line went out
        continue;
      }
      if (run.status === "paused") continue;
      const session = run.roles[row.role];
      if (!session) { await this.spawnFor(run, row); continue; }
      if (this.store.sessionStatus(session) === "active") continue;
      if (this.now() - (this.lastTyped.get(session) ?? -Infinity) < (this.o.gapMs ?? 2_000)) continue;
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
    try {
      const cwd = expandHome(renderTemplate(role.cwd ?? p.cwd, renderData(run)));
      const session = await this.agterm.spawn({ cwd, command: spawnCommand(role.spawn, row.text), workspace: run.process, name: `${run.id} ${row.role}` });
      this.store.markSent(row.id, this.now());
      this.lastTyped.set(session, this.now() + (this.o.spawnGraceMs ?? 15_000));
      await this.submit({ type: "role.bind", run: run.id, data: { role: row.role, session, by: "spawn" }, source: "flowd" });
      if (row.entry_id) await this.submit({ type: "entry.delivered", run: run.id, entry: row.entry_id, data: {}, source: "flowd" });
    } catch (e) {
      this.log(`spawn ${run.id} ${row.role}: ${msg(e)}`);
      if (this.store.bumpOutbox(row.id) >= 3) {
        this.store.markSent(row.id, this.now());
        await this.submit({ type: "role.failed", run: run.id, data: { role: row.role, reason: `spawn failed: ${msg(e)}` }, source: "flowd" });
      }
    } finally {
      this.spawning.delete(key);
    }
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
    if (s?.event) lines.push(`woken by: ${s.event.type}${s.event.outcome ? ` ${s.event.outcome}` : ""} ${JSON.stringify(s.event.data)}`);
    const vars = Object.entries(run.vars);
    if (vars.length) lines.push(`vars: ${vars.map(([k, v]) => `${k}=${v}`).join("  ")}`);
    lines.push("", prompt, "", entry.kind === "human"
      ? `Close it in the UI or with \`flow done --human --run ${shq(run.id)} --step ${entry.id}\``
      : "Report: `flow done [--note …] [--evidence URL]` · `flow failed --note …` · `flow set key=value`");
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
    return {
      id: run.id, process: run.process, iteration: run.iteration, status: run.status, reason: run.reason ?? null,
      current: run.current, currentStatus: s?.status ?? null, currentKind: cur?.kind ?? null,
      waitingOn: s?.status === "waiting" ? cur?.waitFor?.on ?? null : null,
      roles: run.roles, vars: run.vars,
      needsYou: run.status === "needs-human" || (cur?.kind === "human" && (s?.status === "active" || s?.status === "waiting")),
      plan: (p?.entries ?? []).map((e) => ({
        id: e.id, kind: e.kind, role: e.role ?? null, detour: e.detour, waitFor: e.waitFor?.on ?? null,
        status: run.entries[e.id]?.status ?? "pending",
      })),
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
