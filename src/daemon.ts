import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Cron } from "croner";
import { loadDefs, type DefCtx } from "./defs.ts";
import { formatDuration, matches, missingProcess, newRun, ordinal, renderData, renderPrompt, renderWith, step } from "./engine.ts";
import { expandHome, shq, type SessionInfo, type SpawnOpts, type Terminal } from "./agterm.ts";
import { zmxName } from "./zmx.ts";
import { findClaudeSession, findCodexSession } from "./transcripts.ts";
import { agentOf, agentSpawn, lineSkills, resumeSpawn } from "./skills.ts";
import { PluginHost, msg, readPluginConfig, subscriptionKey, type ActiveChat, type ChatMessage, type Watch } from "./plugins.ts";
import { Store, type OutboxRow, type StoredEvent } from "./store.ts";
import { renderTemplate } from "./template.ts";
import { killGroup, Translator } from "./translate.ts";
import { Reports } from "./reports.ts";
import { TERMINAL } from "./types.ts";
import type { Defs, Dict, Entry, FlowEvent, Input, Notify, OnFail, Process, RunState, SessionStatus, StepResult } from "./types.ts";

export interface FlowdOptions {
  home: string;
  statePath: string;
  agterm: Terminal;
  /** headless sessions for processes with `terminal: zmx` */
  zmx?: Terminal;
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
  /** Claude Code's own directory: transcripts in `projects/`, the user's skills, installed plugins. Default `$CLAUDE_CONFIG_DIR`, else `~/.claude` */
  claudeDir?: string;
  /** Codex's own directory: `config.toml` (trusted folders), `sessions/`. Default `$CODEX_HOME`, else `~/.codex` */
  codexDir?: string;
  /** the translator for step prompts: an argv; the instruction is appended, the text goes to stdin (default: Codex gpt-6-luna) */
  translate?: string[];
  /** how long a translation may take before its process group is killed (default 2 minutes) */
  translateTimeoutMs?: number;
  /** languages every step's prompt is translated into ahead of time, while the translator is idle (none by default) */
  pretranslate?: string[];
  /** how long after a step file changes the steps are translated ahead (default 1 minute; twice that after start) */
  pretranslateDelayMs?: number;
  /** how often the folder-trust dialog is looked for after a spawn (30 looks) */
  trustPollMs?: number;
  /** pause_on: between Esc to an agent and the line telling it to stop */
  pauseKeyDelayMs?: number;
  /** how often every open run's title is re-read from its PR (0: never on a timer) */
  titleMs?: number;
  /** agents' reports: where the copies live and the public base of their links (FLOWS_REPORTS_URL); none: not served */
  reports?: { dir: string; url: string };
  /** how a shell entry's command is run; the command is appended (default: a login zsh) */
  shell?: string[];
}

export interface Result {
  error?: string; run?: string; queued?: { position: number; open: number; max: number };
  /** a start taken as the choice for a run's inner still ahead: `process` runs inside `in` once it gets there */
  nests?: { process: string; in: string };
}

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
  /** what a person calls it (runName), and its process (`label:`, else the name) */
  id: string; name: string; label: string; process: string;
  /** roles put to sleep by hibernate: the next line to one resumes its conversation */
  asleep: string[]; iteration: number; status: string; reason: string | null;
  current: string | null; currentStatus: string | null; currentKind: string | null; waitingOn: string | null;
  roles: Record<string, string | null>; vars: Record<string, string>; needsYou: boolean;
  agentWait: { note: string; human: boolean; since: number } | null;
  /** the current entry is a pause: when it ends (ms) */
  waitUntil: number | null;
  /** a nested run: the run whose agent it works in; and the nested run working in this one's */
  parent: string | null;
  child: string | null;
  /** queued for a hold: its name and the run that has it */
  heldBy: { hold: string; run: string | null } | null;
  /** a queued run: its place in line and how full its process is */
  queue: { position: number; open: number; max: number } | null;
  /** agent roles run by Claude in agterm: their conversation can be reopened once the session is gone */
  resumable: string[];
  created: number; updated: number;
  plan: PlanItem[];
}

const pad = (n: number) => String(n).padStart(2, "0");
/**
 * What a person calls a run: its title first (`<title> · <label>`), else `<label> · DD.MM HH:MM`, when it
 * was created in local time — a sync is known by its day, not its number. The label is the process's
 * `label:`, else its name.
 */
export function runName(run: RunState, label: string | undefined, created: number): string {
  const what = label ?? run.process;
  const title = run.vars.title?.trim();
  if (title) return `${title} · ${what}`;
  const d = new Date(created);
  return `${what} · ${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const AGTERM_STATUSES = new Set(["active", "completed", "idle", "blocked"]);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const stepBodies = (d: Defs) => JSON.stringify(Object.values(d.steps).map((s) => [s.id, s.body]));
/** Text already mostly in a language's script needs no translation into it. */
const SCRIPTS: Record<string, RegExp> = { ru: /\p{Script=Cyrillic}/gu, en: /\p{Script=Latin}/gu };
const writtenIn = (text: string, lang: string): boolean => {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const own = SCRIPTS[lang] ? text.match(SCRIPTS[lang])?.length ?? 0 : 0;
  // commands and paths are Latin in any language: a third in Cyrillic is a Russian prompt
  return letters > 0 && own / letters > (lang === "ru" ? 0.3 : 0.7);
};
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);
const stringVars = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(v && typeof v === "object" ? (v as Dict) : {}).map(([k, x]) => [k, String(x)]));


// the login shell finds codex; "$@" passes the argv through without quoting anything into a string
const TRANSLATE = ["/bin/zsh", "-lc", 'exec "$@"', "zsh", "codex", "exec", "-m", "gpt-6-luna", "--sandbox", "read-only",
  "--ephemeral", "--skip-git-repo-check", "-c", "model_reasoning_effort=low"];

export class Flowd {
  home: string;
  store: Store;
  agterm: Terminal;
  zmx: Terminal | undefined;
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
  private warmTimer: ReturnType<typeof setTimeout> | undefined;
  private warming = false;
  private warmAgain = false;
  private listeners = new Set<(what: "runs" | "defs") => void>();
  private lastTyped = new Map<string, number>();
  private spawning = new Set<string>();
  /** processes their `pause_on` switch has paused: their starts queue, their queue waits */
  private pausedProcesses = new Set<string>();
  /** hibernate: `<run>\0<role>\0<session>` being put to sleep, or with no conversation to resume */
  private sleeping = new Set<string>();
  private flushRun: Promise<void> | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private crons: Cron[] = [];
  private watcher: FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;
  private queueing = false;
  private translator: Translator;
  reports: Reports | undefined;
  private notices: Promise<unknown> = Promise.resolve();
  private opening = new Map<string, Promise<string>>(); // a root run's conversation being opened
  private subscribing = false; // set by init once stored events replayed: a trigger may start runs from then on

  constructor(o: FlowdOptions) {
    this.o = o;
    this.translator = new Translator({
      argv: o.translate ?? TRANSLATE, dir: join(dirname(o.statePath), "translations"),
      timeoutMs: o.translateTimeoutMs ?? 120_000, max: 2,
    });
    this.reports = o.reports ? new Reports(o.reports) : undefined;
    this.home = o.home;
    this.agterm = o.agterm;
    this.zmx = o.zmx;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.error(`[flowd] ${m}`));
    this.store = new Store(o.statePath);
    this.plugins = new PluginHost({
      dirs: o.pluginDirs,
      config: readPluginConfig(o.home, this.log),
      sink: (e) => { void this.submit(e); },
      onMessage: (adapter, m) => { void this.enqueue(() => this.incoming(adapter, m)); },
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
    // runs resuming come first: the steps are translated ahead a while after start
    this.scheduleWarm(2 * (this.o.pretranslateDelayMs ?? 60_000));
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
      // a nested run that ended while flowd was down: its parent still waits on inner
      for (const run of this.store.openRuns()) {
        const child = run.current ? run.entries[run.current]?.child : undefined;
        if (child && TERMINAL.includes(this.store.getRun(child)?.status ?? "done")) await this.nestedEnd(child);
      }
      for (const run of this.store.openRuns()) this.rearm(run);
      this.grantHolds();
      await this.startQueued();
      this.subscribing = true;
      this.syncSubscriptions();
    });
    const tickMs = this.o.tickMs ?? 5_000;
    const flushMs = this.o.flushMs ?? 1_000;
    if (tickMs > 0) this.timers.push(setInterval(() => { void this.tickNow(); }, tickMs));
    if (flushMs > 0) this.timers.push(setInterval(() => { void this.flush(); }, flushMs));
    const titleMs = this.o.titleMs ?? 600_000;
    if (this.reports) {
      this.reports.prune();
      this.timers.push(setInterval(() => this.reports?.prune(), 86_400_000));
    }
    if (titleMs > 0) {
      this.timers.push(setInterval(() => { void this.refreshTitles(); }, titleMs));
      this.background(this.refreshTitles()); // runs that got their PR while flowd was down
    }
    if (this.o.watchDefs !== false) this.watcher = fsWatch(this.home, { recursive: true }, () => this.scheduleReload());
  }

  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.warmTimer);
    this.translator.close();
    for (const c of this.children) killGroup(c); // a restart fails what was cut off: see init
    for (const t of this.timers) clearInterval(t);
    for (const c of this.crons) c.stop();
    clearTimeout(this.reloadTimer);
    this.watcher?.close();
    await this.plugins.stopAll();
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
    // an edit that does not parse or validate is not taken (a typo, a save halfway): open runs go on with
    // the last good version; new starts are refused with the edit's errors
    for (const [name, p] of Object.entries(before.processes)) if (!this.defs.processes[name] && this.defs.invalid[`process:${name}`]) this.defs.processes[name] = p;
    for (const [id, s] of Object.entries(before.steps)) if (!this.defs.steps[id] && this.defs.invalid[`step:${id}`]) this.defs.steps[id] = s;
    // an edited prompt is translated ahead once the edits settle (the UI editor saves often)
    if (this.loaded && stepBodies(before) !== stepBodies(this.defs)) this.scheduleWarm(this.o.pretranslateDelayMs ?? 60_000);
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
    if (this.loaded) void this.enqueue(async () => { this.grantHolds(); await this.startQueued(); }); // a hold gone, max_runs raised
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
      // a pause_on switch is a standing subscription too, served like a trigger's
      for (const t of [...p.triggers, ...(p.pauseOn ? [p.pauseOn] : [])]) {
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

  /** The terminal a session lives in: its id says which. */
  termOf(session: string): Terminal {
    if (!session.startsWith("zmx:")) return this.agterm;
    if (!this.zmx) throw new Error(`${session} is a zmx session and zmx is not configured in this flowd`);
    return this.zmx;
  }

  /** Sessions bound to open runs. */
  private heldSessions(): Set<string> {
    return new Set(this.store.openRuns().flatMap((r) => Object.values(r.roles)).filter((s): s is string => Boolean(s)));
  }

  /** Every session the terminals know of; zmx only asked while a run holds one of its sessions. */
  async sessions(): Promise<SessionInfo[]> {
    const zmx = this.zmx && [...this.heldSessions()].some((s) => s.startsWith("zmx:")) ? await this.zmx.tree().catch(() => []) : [];
    return [...await this.agterm.tree(), ...zmx];
  }

  private async sessionTurn(session: string, status: SessionStatus): Promise<Result> {
    this.store.setSessionStatus(session, status, this.now());
    for (const r of this.store.openRuns()) {
      if (Object.values(r.roles).includes(session)) await this.apply(r.id, { kind: "session", session, status });
    }
    if (status !== "active") void this.flush();
    return {};
  }

  private async reconcileSessions(): Promise<void> {
    let live: SessionInfo[] | undefined;
    try {
      live = await this.agterm.tree();
    } catch (e) {
      this.log(`agterm tree: ${msg(e)}`);
    }
    for (const s of live ?? []) {
      // active before the restart and cleared now: the turn ended while flowd was down
      // (agterm resets completed to idle on the user's first key), so it counts as completed
      const was = this.store.sessionStatus(s.id);
      const shown = s.status && s.status !== "idle" ? s.status : undefined; // agterm omits idle
      const now = shown ?? (was === "active" ? "completed" : "idle");
      this.store.setSessionStatus(s.id, now, this.now());
    }
    const held = [...this.heldSessions()];
    // zmx shows no turn status: a zmx session keeps the one its hooks last reported
    let zmxLive: SessionInfo[] | undefined;
    if (this.zmx && held.some((s) => s.startsWith("zmx:"))) {
      try {
        zmxLive = await this.zmx.tree();
      } catch (e) {
        this.log(`zmx list: ${msg(e)}`);
      }
    }
    const ids = new Set([...live ?? [], ...zmxLive ?? []].map((s) => s.id));
    for (const session of held) {
      if (!(session.startsWith("zmx:") ? zmxLive || !this.zmx : live)) continue; // cannot tell
      // a turn that ended while flowd was down must still start its reminder clock
      if (ids.has(session)) void this.submit({ type: "agterm.status", data: { session, status: this.store.sessionStatus(session) }, source: "flowd" });
      else void this.submit({ type: "agterm.closed", data: { session }, source: "flowd" });
    }
  }

  /**
   * Sessions that send no closed event: a zmx session (missing from `zmx list`) and a split pane
   * (agterm reports a closed split as hidden; gone from the tree once its pane is destroyed).
   */
  private async checkUnannounced(): Promise<void> {
    const held = [...this.heldSessions()];
    for (const [term, ids] of [[this.zmx, held.filter((s) => s.startsWith("zmx:"))], [this.agterm, held.filter((s) => s.endsWith(":right"))]] as const) {
      if (!term || !ids.length) continue;
      let live: Set<string>;
      try {
        live = new Set((await term.tree()).map((s) => s.id));
      } catch (e) {
        this.log(`session list: ${msg(e)}`);
        continue;
      }
      for (const session of ids) {
        if (!live.has(session) && this.store.sessionStatus(session) !== "closed") {
          void this.submit({ type: "agterm.closed", data: { session }, source: "flowd" });
        }
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
        return this.startRun(String(d.process ?? ""), stringVars(d.bind), str(d.trigger), undefined, stringVars(d.vars), { inner: strings(d.inner) });
      case "run.nested-end":
        return this.nestedEnd(run);
      case "run.nest": {
        // an inner entry's start-child: the next process of the chain, on the agent the entry lends
        // from --inner (entry named; a refusal fails the inner) or from the UI (the current entry;
        // a refusal is the answer, the person picks again)
        const ui = d.ui === true;
        const parent = this.store.getRun(run);
        const cur = parent && this.currentEntry(parent);
        const at = ui ? cur?.id : entry;
        if (!parent || !cur || cur.id !== at || cur.kind !== "inner" || parent.entries[cur.id].child || parent.entries[cur.id].status !== "waiting") {
          return ui ? { error: `${run} is not waiting for a nested process` } : {};
        }
        const p = this.defs.processes[String(d.process)];
        const role = p && (p.roles[cur.role!] ? cur.role! : Object.keys(p.roles).length === 1 ? Object.keys(p.roles)[0] : undefined);
        const res = !p ? { error: `no valid process ${String(d.process)}` }
          : !role ? { error: `${p.name} has roles ${Object.keys(p.roles).join(", ")}; none is ${cur.role}` }
          : !parent.roles[cur.role!] ? { error: `${cur.role} has no session to lend ${p.name}` }
          : await this.startRun(p.name, { [role]: parent.roles[cur.role!]! }, undefined, undefined, {}, { inner: strings(d.chain), parent: { run, entry: cur.id } });
        if (res.error && !ui) return this.apply(run, { kind: "report", entry: cur.id, outcome: "failed", note: res.error, by: "system" });
        return res;
      }
      case "agterm.status":
      case "agterm.closed": {
        const session = String(d.session ?? "");
        if (!session) return { error: "no session" };
        if (e.type === "agterm.closed") {
          // a closed session takes its split pane with it
          if (!session.endsWith(":right") && this.heldSessions().has(`${session}:right`)) await this.sessionTurn(`${session}:right`, "closed");
          return this.sessionTurn(session, "closed");
        }
        // a status belongs to the pane that set it; the scratch pane runs no agent of flows
        if (d.pane === "scratch") return {};
        const pane = d.pane === "right" && !session.endsWith(":right") ? `${session}:right` : session;
        return this.sessionTurn(pane, (AGTERM_STATUSES.has(String(d.status)) ? d.status : "idle") as SessionStatus);
      }
      case "claude.status": {
        // Claude Code's own hooks: the turn signal for zmx sessions, which have no agterm to report it
        const session = String(d.session ?? "");
        if (!session.startsWith("zmx:") || !this.store.runBySession(session)) return {};
        // Only the agent's own Claude moves the turn, not a `claude -p` it runs: the id it reported
        // first is kept (in the store, so a restart keeps it too). A compaction gives the agent a
        // new id mid-turn; /clear and a resume do at its prompt — mid-turn they are a nested claude.
        const claude = str(d.claude);
        const known = this.store.sessionClaude(session);
        const current = this.store.sessionStatus(session);
        if (d.event === "start") {
          const moves = d.source === "compact" || ((d.source === "clear" || d.source === "resume") && current !== "active");
          if (claude && (!known || moves)) this.store.setSessionClaude(session, claude, this.now());
          return {};
        }
        if (claude && known && claude !== known) return {};
        if (claude && !known) this.store.setSessionClaude(session, claude, this.now());
        // idle_prompt: Claude has sat at its prompt for a minute. It heals a turn whose Stop was
        // missed (flowd down, an Esc); otherwise it says nothing new.
        if (d.event === "idle") return current === "active" ? this.sessionTurn(session, "completed") : {};
        const status = ({ active: "active", completed: "completed", blocked: "blocked" } as Record<string, SessionStatus>)[String(d.event)];
        return status ? this.sessionTurn(session, status) : { error: `unknown Claude event ${String(d.event)}` };
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
        if (by === "agent") {
          const foreign = this.foreignAgent(d, t);
          if (foreign) return { error: foreign };
        }
        return this.apply(t.run, { kind: "report", entry: t.entry, outcome, note: str(d.note), evidence: str(d.evidence), by });
      }
      case "entry.wait": {
        const t = this.resolveTarget(d);
        if ("error" in t) return t;
        const foreign = d.human === true ? undefined : this.foreignAgent(d, t);
        if (foreign) return { error: foreign };
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
      case "entry.skip": {
        // flow skip names a run or comes from its session: the step is that run's current one
        const target = run ? this.store.getRun(run) : str(d.session) ? this.store.runBySession(String(d.session))?.run : undefined;
        if (!entry && !run && !str(d.session)) return { error: "no session: run this inside a flow session, or pass a run" };
        if (!target) return { error: run ? `no run ${run}` : "no open run is bound to this session" };
        return this.apply(target.id, { kind: "skip", entry: entry || (target.current ?? ""), note: String(d.note ?? "") });
      }
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
      case "run.ping":
        return this.apply(run, { kind: "ping" });
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
      case "role.sleep": {
        // checked again here, in the event chain: the run may have woken since the tick looked
        const r = this.store.getRun(run);
        const role = String(d.role ?? ""), session = String(d.session ?? "");
        const status = this.store.sessionStatus(session);
        if (!r || !this.parked(r) || (status !== "completed" && status !== "idle") || this.store.pendingOutbox().some((x) => x.run_id === run && x.role === role)) {
          return { error: `${run} ${role} is busy again` };
        }
        const agent = d.agent === "codex" ? "codex" : "claude";
        return this.apply(run, { kind: "sleep", role, session, asleep: { agent, conversation: String(d.conversation ?? ""), cwd: String(d.cwd ?? ""), since: this.now() } });
      }
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
        const po = p?.pauseOn;
        if (po && po.on === e.type && subscriptionKey({ type: po.on, cwd: expandHome(p!.cwd), with: po.with }) === e.subscription) {
          if (matches(po.where, e.data)) await this.pauseProcess(name);
          else await this.resumeProcess(name);
        }
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

  /**
   * An agent naming a step with --run/--step from a session that is not the step's: another agent
   * working on the same thing. Its report would race the agent flowd gives the next steps to, and
   * both would do them (a review request posted twice).
   */
  private foreignAgent(d: Dict, t: { run: string; entry: string }): string | undefined {
    const session = str(d.session);
    if (!session || !str(d.run)) return undefined;
    const run = this.store.getRun(t.run);
    const role = run ? this.defs.processes[run.process]?.entries.find((x) => x.id === t.entry)?.role : undefined;
    const own = run && role && role !== "human" ? run.roles[role] : null;
    if (!own || own === session) return undefined;
    return `step ${t.entry} of ${t.run} is its ${role} agent's (session ${own}), and flowd gives that agent the steps that follow: do not do them from this session. To close it as the person, add --human`;
  }

  resolveTarget(d: Dict): { run: string; entry: string } | { error: string } {
    if (typeof d.run === "string" && d.run && typeof d.entry === "string" && d.entry) return { run: d.run, entry: d.entry };
    const session = typeof d.session === "string" ? d.session : "";
    if (!session) return { error: "no session: run this inside a flow session, or pass --run and --step" };
    const hit = this.store.runBySession(session);
    if (!hit) return { error: "no open run is bound to this session" };
    if (hit.run.status === "queued") {
      return { error: `${hit.run.id} is queued (${ordinal(this.queueOf(hit.run).position)} in line); its first step comes when a run of ${hit.run.process} ends` };
    }
    const cur = hit.run.current ? this.defs.processes[hit.run.process]?.entries.find((x) => x.id === hit.run.current) : undefined;
    if (!cur || cur.role !== hit.role) {
      return { error: `no active step for this session (${hit.run.id} is at ${hit.run.current ?? "nothing"}${cur?.role ? `, role ${cur.role}` : ""})` };
    }
    return { run: hit.run.id, entry: cur.id };
  }

  private async startRun(name: string, bind: Record<string, string>, trigger?: string, ev?: FlowEvent, vars: Record<string, string> = {},
    opts: { inner?: string[]; parent?: { run: string; entry: string } } = {}): Promise<Result> {
    const p = this.defs.processes[name];
    const why = this.defs.invalid[`process:${name}`];
    // an invalid edit's last good version serves the runs it has, not new ones
    if (!p || why) return { error: `no valid process ${name}${why ? `: ${why.join("; ")}` : ""}` };
    const chainError = this.chainError(name, opts.inner ?? []);
    if (chainError) return { error: chainError };
    let parent = opts.parent;
    for (const [role, session] of Object.entries(bind)) {
      if (!p.roles[role]) return { error: `${name} has no role ${role}` };
      const taken = this.store.runBySession(session);
      if (!taken || taken.run.id === parent?.run) continue;
      const at = this.lendingEntry(taken.run, session);
      if (!at && !parent && this.innerAhead(taken.run, taken.role)) {
        // the inner is still ahead: this start is its choice, as --inner at that run's start would have been
        const host = taken.run;
        if (host.inner?.length) return { error: `${host.id} already runs ${host.inner[0]} inside when it reaches inner; stop ${host.id} to choose again` };
        if (Object.keys(vars).length) return { error: `${name} cannot keep --var until ${host.id} reaches inner: start it then, or without --var` };
        const chain = [name, ...(opts.inner ?? [])];
        const why = this.chainError(host.process, chain);
        if (why) return { error: why };
        host.inner = chain;
        this.store.saveRun(host, this.now());
        this.changed("runs");
        return { run: host.id, nests: { process: name, in: host.id } };
      }
      if (!at || parent) {
        const nests = this.defs.processes[taken.run.process]?.entries.some((e) => e.kind === "inner");
        return { error: nests && !parent
          ? `${taken.role} is busy with ${taken.run.id} at step ${taken.run.current ?? "none"}; a nested process can start when it reaches inner`
          : `session ${session} is already bound to ${taken.run.id}` };
      }
      parent = { run: taken.run.id, entry: at };
    }
    const parentRun = parent ? this.store.getRun(parent.run) : null;
    if (parent && parentRun) {
      const lent = Object.keys(bind).filter((r) => Object.values(parentRun.roles).includes(bind[r]));
      const clears = p.entries.find((e) => e.do === "clear" && lent.includes(e.role ?? ""));
      if (clears) return { error: `${name} clears ${clears.role}'s context, which ${parent.run} still needs; use compact` };
      vars = { ...parentRun.vars, ...vars };
    }
    const runs = this.store.openRuns().filter((r) => r.process === name);
    const cap = this.capacity(p, runs);
    const { open, max } = cap;
    // a process its pause_on switch paused takes starts into its queue
    const full = cap.full || this.pausedProcesses.has(name);
    // a schedule fires again; a start by hand or by an event is work that must not be lost. A start
    // that flow.trigger.skipped itself caused is refused without another one: that would feed itself
    if (full && (trigger === "cron" || trigger === "flow.trigger.skipped")) {
      if (trigger === "cron") void this.submit({ type: "flow.trigger.skipped", data: { process: name, trigger }, source: "flow" });
      return { error: `${name} already has ${open} ${p.maxWorking === undefined ? "open" : "working"} run(s) (${p.maxWorking === undefined ? "max_runs" : "max_working"} ${max})` };
    }
    const n = this.store.nextRunNumber(name);
    const run = newRun(`${name}#${n}`, p, bind);
    if (opts.inner?.length) run.inner = opts.inner;
    if (parent) {
      run.parent = { ...parent, vars: { ...vars } };
      // attached before it starts, so a run that ends at once still finds its parent waiting
      const attached = await this.apply(parent.run, { kind: "child", entry: parent.entry, child: run.id });
      if (attached.error) return attached;
    }
    const event = ev ? { type: ev.type, outcome: ev.outcome, data: ev.data, source: ev.source } : undefined;
    if (full) {
      const position = runs.filter((r) => r.status === "queued").length + 1;
      Object.assign(run, { status: "queued", vars: { ...vars }, queuedEvent: event, queuePos: position });
      this.store.createRun(run, n, this.now());
      this.changed("runs");
      return { run: run.id, queued: { position, open, max } };
    }
    this.store.createRun(run, n, this.now());
    return this.apply(run.id, { kind: "start", vars, event });
  }

  /** A nested run ended: its parent's inner closes with it, done with the vars it set, else failed. */
  private async nestedEnd(childId: string): Promise<Result> {
    const child = this.store.getRun(childId);
    const link = child?.parent;
    const parent = link && this.store.getRun(link.run);
    if (!child || !link || !parent || parent.current !== link.entry || parent.entries[link.entry]?.child !== childId) return {};
    if (child.status !== "done") {
      return this.apply(parent.id, { kind: "report", entry: link.entry, outcome: "failed", note: `${childId} ${child.status}${child.reason ? `: ${child.reason}` : ""}`, by: "system" });
    }
    const set = Object.fromEntries(Object.entries(child.vars).filter(([k, v]) => link.vars[k] !== v));
    if (Object.keys(set).length) await this.apply(parent.id, { kind: "set", vars: set });
    return this.apply(parent.id, { kind: "report", entry: link.entry, outcome: "done", note: `${childId} done`, by: "system" });
  }

  /** Why `--inner` cannot be placed: each process but the last needs an inner entry for the next. */
  private chainError(name: string, chain: string[]): string | undefined {
    let host = name;
    for (const [i, next] of chain.entries()) {
      if (!this.defs.processes[host]?.entries.some((e) => e.kind === "inner")) return `${host} has no inner step, so ${next} has nowhere to go`;
      if (next === "none") return i === chain.length - 1 ? undefined : "none must be the last of --inner";
      const p = this.defs.processes[next];
      const why = this.defs.invalid[`process:${next}`];
      if (!p || why) return `no valid process ${next}${why ? `: ${why.join("; ")}` : ""}`;
      if (p.repeat) return `${next} repeats (repeat: true), so it never ends and cannot run nested`;
      host = next;
    }
    return undefined;
  }

  /** Whether the run has an inner entry for this role still to come in this iteration. */
  private innerAhead(run: RunState, role: string): boolean {
    return (this.defs.processes[run.process]?.entries ?? []).some((e) =>
      e.kind === "inner" && e.role === role && (run.entries[e.id]?.status ?? "pending") === "pending");
  }

  /** The inner entry a run lends this session's agent on: current, waiting, nobody nested yet. */
  private lendingEntry(run: RunState, session: string): string | undefined {
    const cur = this.currentEntry(run);
    const s = cur && run.entries[cur.id];
    if (run.status !== "running" || cur?.kind !== "inner" || s?.status !== "waiting" || s.child || run.roles[cur.role!] !== session) return undefined;
    return cur.id;
  }

  private async apply(runId: string, input: Input): Promise<Result> {
    const run = this.store.getRun(runId);
    if (!run) return { error: `no run ${runId}` };
    const res = step(run, input, this.ctxFor(run));
    if (res.error) return { error: res.error, run: runId };
    this.commit(res);
    this.grantHolds();
    await this.startQueued();
    if (res.run.vars.pr && res.run.vars.pr !== run.vars.pr) this.background(this.refreshTitle(runId));
    return { run: runId };
  }

  /** The run a nested run works for, all the way up: the stack talks in its conversation. */
  private rootOf(run: RunState): RunState {
    let r = run;
    for (let up = r.parent && this.store.getRun(r.parent.run); up; up = r.parent && this.store.getRun(r.parent.run)) r = up;
    return r;
  }

  /** The root run's conversation in the active messenger, opened once: callers at the same time share it. */
  private chatFor(root: RunState, a: ActiveChat): Promise<string> {
    const had = this.store.chatOf(root.id);
    if (had?.adapter === a.name) return Promise.resolve(had.address);
    let p = this.opening.get(root.id);
    if (!p) {
      p = (async () => {
        const address = await a.chat.open({ id: root.id, process: root.process, title: root.vars.title, name: this.nameOf(root) }, a.ctx);
        this.store.setChat(root.id, a.name, address);
        return address;
      })().finally(() => this.opening.delete(root.id));
      this.opening.set(root.id, p);
    }
    return p;
  }

  /**
   * The person wrote in a run's conversation: the agent of the step the stack is on gets it, through
   * the outbox, so it is typed once the agent's turn has ended and nobody types in the terminal.
   */
  private async incoming(adapter: string, m: ChatMessage): Promise<void> {
    const root = this.store.runByChat(adapter, m.address);
    if (!root) { this.log(`[${adapter}] a message in a conversation no run has (${m.address})`); return; }
    const reply = (text: string) => {
      const a = this.plugins.chat();
      if (!a || "error" in a || a.name !== adapter) return;
      this.background(Promise.resolve(a.chat.post(m.address, { text }, a.ctx)).catch((e) => this.plugins.fault(adapter, e)));
    };
    if (TERMINAL.includes(root.status)) return reply(`${root.id} has ended`);
    let top = root;
    for (let c = this.childOf(top); c; c = this.childOf(top)) top = c;
    const cur = this.currentEntry(top);
    const st = cur ? top.entries[cur.id] : undefined;
    // a sleeping agent counts: the message wakes it into its conversation (hibernate)
    const has = (r: string) => Boolean(top.roles[r] || top.asleep?.[r]);
    const onStep = top.status === "running" && cur?.kind === "agent" && cur.role && has(cur.role) && st?.status !== "pending" ? cur.role : undefined;
    // the person writes whenever they like: between steps (theirs, a wait) the agent that worked last answers,
    // else any agent the run has
    const role = onStep ?? this.lastAgent(top) ?? Object.keys(top.roles).find(has);
    if (!role) {
      const where = top.status !== "running" ? `it is ${top.status}` : `it is at ${cur?.id ?? "nothing"} (${cur?.kind ?? "no step"})`;
      return reply(`${top.id} has no agent yet: ${where}. Write again once one has started`);
    }
    const off = onStep ? "" : `\n↳ The run is at ${cur?.id ?? "no step"}, not a step of yours: answer, and do not run flow done or flow failed for it.`;
    // the agent is told plainly where the person is, or it answers in a terminal nobody reads; not that it
    // must answer: a go-ahead needs none, and a forced "ok, going on" is noise
    this.store.enqueue(top.id, role,
      `${m.from} wrote in the run's ${adapter} conversation (${top.id}):\n${m.text}\n↳ ${m.from} reads ${adapter}, not this terminal: when you answer, answer with \`flow say "…"\`. A go-ahead needs no answer — just carry on.${off}`,
      null, this.now());
    void this.flush();
  }

  /** The role whose agent step started last in this iteration and whose session is still bound. */
  private lastAgent(run: RunState): string | undefined {
    let best: { role: string; at: number } | undefined;
    for (const e of this.defs.processes[run.process]?.entries ?? []) {
      const at = run.entries[e.id]?.startedAt;
      if (e.kind !== "agent" || !e.role || !(run.roles[e.role] || run.asleep?.[e.role]) || at === undefined || run.entries[e.id].status === "pending") continue;
      if (!best || at >= best.at) best = { role: e.role, at };
    }
    return best?.role;
  }

  /** The open nested run standing on this run's current inner entry. */
  private childOf(run: RunState): RunState | undefined {
    const id = run.current ? run.entries[run.current]?.child : undefined;
    const c = id ? this.store.getRun(id) : null;
    return c && !TERMINAL.includes(c.status) ? c : undefined;
  }

  /** `flow publish`: a copy of the file under an unguessable link. */
  publish(file: string): { url: string } | { error: string } {
    if (!this.reports) return { error: "reports are not served: set FLOWS_REPORTS_URL (docs/cli.md#flow-publish)" };
    return this.reports.publish(file);
  }

  /** `flow say`: the agent writes to its run's conversation. */
  async say(q: { session?: string; run?: string; text: string; file?: string }): Promise<{ error?: string }> {
    const a = this.plugins.chat();
    if (!a) return { error: "no chat is set up: add a telegram section to $FLOWS_HOME/plugins.yaml (docs/plugins.md)" };
    if ("error" in a) return a;
    const run = q.run ? this.store.getRun(q.run) : q.session ? this.store.runBySession(q.session)?.run : undefined;
    if (!run) return { error: q.run ? `no run ${q.run}` : q.session ? "no open run is bound to this session" : "no session: run this inside a flow session, or pass --run" };
    if (q.file && !existsSync(q.file)) return { error: `no file ${q.file}` };
    let m: { text: string; file?: string } = { text: q.text, ...(q.file ? { file: q.file } : {}) };
    if (q.file && this.reports && /\.html?$/i.test(q.file)) {
      // a page reads better as a link than as a download
      const p = this.reports.publish(q.file);
      if ("error" in p) return p;
      m = { text: `${q.text}\n${p.url}` };
    }
    try {
      await a.chat.post(await this.chatFor(this.rootOf(run), a), m, a.ctx);
      return {};
    } catch (e) {
      this.plugins.fault(a.name, e);
      return { error: `${a.name}: ${msg(e)}` };
    }
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

  /**
   * Starts queued runs, oldest first, while their process has fewer than max_runs open, then tells
   * the rest their new place. Every apply ends here, so it runs inside itself: the flag stops that.
   */
  private async startQueued(): Promise<void> {
    if (this.queueing) return;
    this.queueing = true;
    try {
      const open = this.store.openRuns();
      for (const name of new Set(open.filter((r) => r.status === "queued").map((r) => r.process))) {
        const p = this.defs.processes[name];
        if (!p || this.pausedProcesses.has(name)) continue;
        let position = 0;
        for (const r of open.filter((x) => x.process === name && x.status === "queued")) {
          // read again each time: a run just started counts as working (it may park at once)
          const cap = this.capacity(p, this.store.openRuns().filter((x) => x.process === name));
          if (!cap.full) {
            const started = await this.apply(r.id, { kind: "start", event: r.queuedEvent });
            if (!started.error) this.changed("runs");
            continue;
          }
          position++;
          if (r.queuePos !== position) await this.apply(r.id, { kind: "queued", position, open: cap.open, max: cap.max });
        }
      }
    } finally {
      this.queueing = false;
    }
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
    const before = this.store.getRun(runId);
    const emitted: number[] = [];
    this.store.tx(() => {
      this.store.saveRun(res.run, this.now());
      for (const a of res.actions) {
        if (a.kind === "deliver") this.store.enqueue(runId, a.role, a.text, a.entry ?? null, this.now());
        if (a.kind === "emit") emitted.push(this.store.addEvent(a.event, this.now()));
      }
      if (res.run.status === "stopped") this.store.dropOutbox(runId);
    });
    if (TERMINAL.includes(res.run.status)) {
      if (res.run.parent) void this.submit({ type: "run.nested-end", run: runId, data: {}, source: "flowd" });
      for (const c of this.store.childrenOf(runId)) void this.submit({ type: "run.stop", run: c.id, data: {}, source: "flowd" });
    }
    for (const a of res.actions) {
      if (a.kind === "watch") this.plugins.watch({ run: runId, entry: a.entry, type: a.waitFor.on, with: a.waitFor.with, cwd: this.cwdOf(res.run.process), vars: res.run.vars, ...(a.previous ? { previous: a.previous } : {}) });
      else if (a.kind === "unwatch") this.plugins.unwatch(runId, a.entry);
      else if (a.kind === "plugin-action") void this.runAction(runId, a.entry, a.name, a.with);
      else if (a.kind === "shell") this.background(this.runShell(runId, a.entry, a.command, a.cwd, a.env, a.timeoutMs));
      else if (a.kind === "start-child") void this.submit({ type: "run.nest", run: runId, entry: a.entry, data: { process: a.process, chain: a.chain }, source: "flowd" });
    }
    for (const id of emitted) void this.enqueue(() => this.process(id));
    if (res.actions.some((a) => a.kind === "deliver")) void this.flush();
    this.announce(before, res.run);
  }

  /**
   * flowd's own words in the run's conversation, each switched and worded by `notify`: an entry is done
   * (off unless asked), the run comes to need the person, the run ends (then the conversation closes).
   */
  private announce(before: RunState | null, run: RunState): void {
    const a = this.plugins.chat();
    if (!a || "error" in a) return;
    const open = (r: RunState | null) => r !== null && !TERMINAL.includes(r.status);
    const entries = this.defs.processes[run.process]?.entries ?? [];
    const off = this.defs.processes[run.process]?.notify?.off === true;
    const says: (() => Promise<unknown>)[] = [];
    const post = (text: string) => { if (!off) says.push(async () => a.chat.post(await this.chatFor(this.rootOf(run), a), { text }, a.ctx)); };

    // entries that turned done in this commit (a new iteration starts them all over: nothing turned done)
    if (before && before.iteration === run.iteration) {
      for (const e of entries) {
        if (run.entries[e.id]?.status !== "done" || before.entries[e.id]?.status === "done") continue;
        const n = this.notifyOf(e);
        if (!n.done) continue;
        const note = run.entries[e.id]?.note ?? "";
        post(this.notice(n.doneText, run, e, note, `${run.id}: ${e.id} done${note ? `: ${note}` : ""}`));
      }
    }
    // a title that came or changed renames the root's open conversation
    const named = a.chat.rename && !run.parent && open(run) && before && before.vars.title !== run.vars.title && this.store.chatOf(run.id);
    if (named && named.adapter === a.name) {
      const name = this.nameOf(run);
      says.push(() => a.chat.rename!(named.address, name, a.ctx) as Promise<unknown>);
    }
    if (open(before) && !open(run)) {
      const had = this.store.chatOf(run.id);
      // a nested run's end is its root's business; with no conversation, none is opened to say so
      if (!run.parent && had?.adapter === a.name) {
        const n = this.defs.processes[run.process]?.notify ?? {};
        const text = run.status === "done"
          ? this.notice(n.doneText, run, undefined, "", `${run.id} is done`)
          : this.notice(n.stoppedText, run, undefined, run.reason ?? "", `${run.id} was stopped${run.reason ? `: ${run.reason}` : ""}`);
        says.push(async () => {
          if (n.end !== false && !n.off) await a.chat.post(had.address, { text }, a.ctx);
          await a.chat.close(had.address, { outcome: run.status as "done" | "stopped" }, a.ctx);
        });
      }
    } else if (open(run) && this.needsYou(run) && !(before && open(before) && this.needsYou(before))) {
      const cur = this.currentEntry(run);
      const n = cur ? this.notifyOf(cur) : {};
      if (n.waits !== false) {
        const note = this.waitsFor(run);
        // the person acts from the message (a phone): the PR is one tap away
        post(this.notice(n.waitsText, run, cur, note, `${run.id} waits for you: ${note}${run.vars.pr ? `\n${run.vars.pr}` : ""}`));
      }
    }
    // ponytail: one chain for every run's notices, so a run's "done", "waits" and "end" keep their order; per run if it gets slow
    for (const say of says) this.notices = this.notices.then(say).catch((e) => this.plugins.fault(a.name, e));
    if (says.length) this.background(this.notices);
  }

  /** An entry's notify: its own keys over its step file's. */
  private notifyOf(e: Entry): Notify {
    return { ...(e.step ? this.defs.steps[e.step]?.notify : undefined), ...e.notify };
  }

  /** A notify text rendered for this run; one that cannot be rendered gives way to the default, with a line in the log. */
  private notice(text: string | undefined, run: RunState, e: Entry | undefined, note: string, fallback: string): string {
    if (!text) return fallback;
    const n = Number(run.id.split("#").pop());
    const data = {
      ...renderData(run),
      run: { ...(renderData(run).run as Dict), n, title: run.vars.title ?? "" },
      step: { id: e?.id ?? "", summary: (e?.step && this.defs.steps[e.step]?.summary) || "" },
      note, reason: run.reason ?? "",
    };
    try {
      return renderTemplate(text, data);
    } catch (err) {
      this.log(`${run.id}: a notify text was not used (${msg(err)}); sent the default instead`);
      return fallback;
    }
  }

  private needsYou(run: RunState): boolean {
    const cur = this.currentEntry(run);
    const s = cur ? run.entries[cur.id] : undefined;
    return run.status === "needs-human" || (cur?.kind === "human" && (s?.status === "active" || s?.status === "waiting")) || Boolean(s?.wait?.human)
      // a bare inner: nothing nested, nothing chosen at start, so the person picks or skips
      || (run.status === "running" && cur?.kind === "inner" && s?.status === "waiting" && !s.child && !run.inner?.length);
  }

  private waitsFor(run: RunState): string {
    const cur = this.currentEntry(run);
    const s = cur ? run.entries[cur.id] : undefined;
    if (s?.wait?.human) return s.wait.note;
    if (run.status === "needs-human") return run.reason ?? "it stopped";
    if (cur?.kind === "human") return (cur.step && this.defs.steps[cur.step]?.summary) || cur.id;
    return `its ${cur?.id} step: start the process to run inside, or skip it`;
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

  async tickNow(): Promise<void> {
    await this.checkUnannounced();
    this.hibernate();
    return this.enqueue(async () => {
      for (const run of this.store.openRuns()) {
        if (run.status !== "running" && !(run.status === "needs-human" && run.reason === missingProcess(run.process))) continue;
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
      try {
        if (await this.termOf(session).userInput(session)) continue; // the line stays queued; retried on the next flush
        await this.termOf(session).type(session, this.lineFor(run, row));
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
  private async unboundSession(terminal: Terminal, workspace: string, name: string): Promise<string | undefined> {
    try {
      return (await terminal.tree()).find((s) => s.workspace === workspace && s.name === name && !this.store.runBySession(s.id))?.id;
    } catch {
      return undefined; // the terminal is unreachable: the spawn below fails and is retried
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
      const zmx = p.terminal === "zmx";
      const terminal = zmx ? this.termOf("zmx:") : this.agterm;
      // a zmx session's name is its id: one per spawn (the outbox row), so a respawn never types
      // into the old agent and a retry of the same spawn finds its session; zmx has no workspaces,
      // its sessions list as "zmx"
      const name = zmx ? zmxName(`flows-${run.id}-${row.role}-${row.id}`) : renderTemplate(role.name ?? "{{run.id}} {{role}}", { ...renderData(run), role: row.role });
      const workspace = zmx ? "zmx" : p.workspace ?? run.process;
      const window = zmx ? undefined : p.window;
      const labels = zmx ? { run: run.id.replace("#", "."), role: row.role } : undefined;
      // an earlier attempt may have opened the session and lost the answer (flowd died, the socket
      // broke): take that session rather than start the agent twice
      const opened = row.attempts > 0 && !role.beside ? await this.unboundSession(terminal, workspace, name) : undefined;
      attempts = this.store.bumpOutbox(row.id); // counted before spawning, so a crash right after is known
      // a sleeping role (hibernate) wakes into its own conversation, where it left off
      const asleep = run.asleep?.[row.role];
      const spawn = asleep ? resumeSpawn(role.spawn, asleep.agent, asleep.conversation) : agentSpawn(role.spawn);
      const session = opened ?? (role.beside
        ? await this.spawnBeside(run, row.role, role.beside, { cwd, spawn: agentSpawn(role.spawn), prompt: this.lineFor(run, row), workspace, window, name })
        : await terminal.spawn({ cwd: asleep?.cwd || cwd, spawn, prompt: this.lineFor(run, row), workspace, window, name, labels }));
      if (asleep) this.log(`${run.id} ${row.role}: woke ${asleep.agent} conversation ${asleep.conversation} in ${session}`);
      this.store.markSent(row.id, this.now());
      this.lastTyped.set(session, this.now() + (this.o.spawnGraceMs ?? 15_000));
      await this.submit({ type: "role.bind", run: run.id, data: { role: row.role, session, by: "spawn" }, source: "flowd" });
      if (row.entry_id) await this.submit({ type: "entry.delivered", run: run.id, entry: row.entry_id, data: {}, source: "flowd" });
      // an agent that starts on its prompt can report active before the session is the role's: that
      // status went to no run, and stays active for the whole turn — hand it on, or the start watch fires
      if (this.store.sessionStatus(session) === "active") await this.submit({ type: "agterm.status", data: { session, status: "active" }, source: "flowd" });
      // an agent may stop on a screen before it reads the first line (Claude's and Codex's folder
      // trust, Codex's update notice): answer it, beside delivery so other sessions are not held up
      // — whatever spawned it: a step's line, or a `do: type` (often empty, just to start the agent)
      this.watchStartScreens(run.id, row.entry_id, session, cwd, role.spawn);
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
   * A role beside another runs in the split pane of that role's session. When that session is not
   * up yet, its agent is started first with no line: it gets its own step line when its step comes.
   */
  private async spawnBeside(run: RunState, role: string, host: string, o: SpawnOpts): Promise<string> {
    if (!this.agterm.spawnBeside) throw new Error("this terminal has no split panes");
    let session = run.roles[host];
    if (!session) {
      const p = this.defs.processes[run.process]!;
      const h = p.roles[host];
      const cwd = expandHome(renderTemplate(h.cwd ?? p.cwd, renderData(run)));
      const name = renderTemplate(h.name ?? "{{run.id}} {{role}}", { ...renderData(run), role: host });
      session = await this.agterm.spawn({ cwd, spawn: agentSpawn(h.spawn), prompt: "", workspace: o.workspace, window: o.window, name });
      this.lastTyped.set(session, this.now() + (this.o.spawnGraceMs ?? 15_000));
      await this.submit({ type: "role.bind", run: run.id, data: { role: host, session, by: "spawn" }, source: "flowd" });
      this.log(`${run.id}: started ${host} in ${session} for ${role} to run beside`);
      this.watchStartScreens(run.id, null, session, cwd, h.spawn);
    }
    return this.agterm.spawnBeside(o, session);
  }

  /** Every agent flowd spawns, whatever for: a Claude in an untrusted folder, and any Codex. */
  private watchStartScreens(run: string, entry: string | null, session: string, cwd: string, spawn: string): void {
    const agent = agentOf(spawn);
    if (agent === "other") return;
    const trust = agent === "claude" ? !this.claudeTrusts(cwd) : !this.codexTrusts(cwd);
    if (trust || agent === "codex") this.background(this.answerStartScreens(run, entry, session, cwd, agent, trust));
  }

  /**
   * Screens an agent shows before it reads its first line, answered so it starts unattended:
   * - Codex's "Update available": Esc, its skip (the user's choice: flowd never updates Codex);
   * - the folder-trust question, when the folder is not trusted yet: the process spawned an agent
   *   into it, so it trusts it. Claude starts on "No, exit" (Down, then Enter once "Yes, I trust
   *   this folder" is selected), Codex on "Trust and continue" (Enter). Never writes their configs.
   */
  private async answerStartScreens(run: string, entry: string | null, session: string, cwd: string, agent: "claude" | "codex", trust: boolean): Promise<void> {
    const pause = () => new Promise((r) => setTimeout(r, this.o.trustPollMs ?? 1_000));
    const d = agent === "claude"
      ? { who: "Claude Code", marker: "Yes,Itrustthisfolder", yes: /❯(\d+\.)?Yes,Itrustthisfolder/, choice: "Yes, I trust this folder", down: true }
      : { who: "Codex", marker: "Trustthisfolder?", yes: /›1\.Trustandcontinue/, choice: "Trust and continue", down: false };
    // matched with whitespace and box lines taken out: in a narrow pane (a split) a screen wraps
    // nearly a word per line, and a soft wrap can split a word
    const read = async () => (await this.termOf(session).text(session)).replace(/[\s\u2500-\u257f]+/g, "");
    const isUpdate = (screen: string) => agent === "codex" && screen.includes("Updateavailable") && screen.includes("escskip");
    const yesSelected = (screen: string) => d.yes.test(screen);
    // a spawn for a step stops that step; one for a `do: type` stops the run where it stands now
    const stop = async (why: string) => {
      const at = entry ?? this.store.getRun(run)?.current;
      const reason = `${at ?? run}: ${d.who} asks whether to trust ${cwd} and flowd could not ${why} — open the session and choose "${d.choice}"`;
      if (at) await this.submit({ type: "entry.start-blocked", run, entry: at, source: "flowd", data: { reason } });
      else this.log(reason);
    };
    try {
      let skipped = false;
      let unread: unknown; // the last read that failed: a session just made is not realized for a moment
      for (let i = 0; i < 30; i++) {
        if (i) await pause();
        let screen: string;
        try {
          screen = await read();
          unread = undefined;
        } catch (e) {
          unread = e;
          continue;
        }
        if (!skipped && isUpdate(screen)) {
          await this.termOf(session).press(session, "\x1b");
          this.log(`skipped Codex's update screen in ${session}`);
          skipped = true;
          continue;
        }
        if (trust && screen.includes(d.marker)) return await this.answerTrust(session, cwd, d, screen, read, pause, stop);
        // done once nothing more can come: the update screen is Codex's, and comes first
        if (!trust && (skipped || agent !== "codex")) return;
      }
      if (unread) throw unread;
      // no dialog: the start watchdog covers any other hang
    } catch (e) {
      if (trust) await stop(`answer it (${msg(e)})`);
      else this.log(`${run}: reading ${session}'s first screen: ${msg(e)}`);
    }
  }

  private async answerTrust(session: string, cwd: string, d: { who: string; yes: RegExp; down: boolean }, screen: string,
    read: () => Promise<string>, pause: () => Promise<unknown>, stop: (why: string) => Promise<unknown>): Promise<void> {
    // a dialog just drawn may not take keys yet (seen live: one Down, the selection stayed): try again
    for (let i = 0; i < 5 && !d.yes.test(screen) && d.down; i++) {
      await this.termOf(session).press(session, "\x1b[B");
      await pause();
      screen = await read();
    }
    if (!d.yes.test(screen)) {
      await stop('select "Yes"');
      return;
    }
    await this.termOf(session).press(session, "\r");
    this.log(`answered ${d.who}'s folder-trust dialog for ${cwd}`);
  }

  /** A shell entry: run the command as written, the run in its environment; report how it ended. */
  private runShell(run: string, entry: string, command: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<void> {
    const [bin, ...args] = this.o.shell ?? ["/bin/zsh", "-lc"];
    return new Promise((resolve) => {
      let timedOut = false;
      // its own process group, so a timeout or a restart ends what the command started too, not
      // only the shell: a compound command's children would run on (and hold the output open)
      const child = spawn(bin, [...args, command], { cwd: expandHome(cwd), env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: string[] = [], stderr: string[] = [];
      let size = 0;
      const take = (into: string[]) => (b: Buffer) => { if ((size += b.length) < 16 * 1024 * 1024) into.push(String(b)); };
      child.stdout!.on("data", take(stdout));
      child.stderr!.on("data", take(stderr));
      const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
      let ended = false;
      const end = (code: number | null, error?: Error) => {
        if (ended) return; // a spawn error may be followed by close
        ended = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (this.closing) return resolve(); // cut off by shutdown: the next start fails the entry
        const out = stdout.join("").trim();
        let outcome: "done" | "failed" = "done";
        let note = out.split("\n").pop() || "exit 0";
        if (code !== 0 || error) {
          outcome = "failed";
          note = timedOut ? `timed out after ${formatDuration(timeoutMs)}`
            : `exit ${code ?? 1}: ${(stderr.join("").trim() || out || error?.message || "killed").slice(-500)}`;
        }
        resolve(this.submit({ type: "entry.report", data: { run, entry, outcome, note: note.slice(0, 500), by: "system" }, source: "flowd" }).then(() => undefined));
      };
      child.on("error", (e) => end(null, e));
      child.on("close", (code) => end(code));
      this.children.add(child);
    });
  }

  private claudeDir(): string {
    return this.o.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  }

  /**
   * A step line as the role's agent gets it: the step's skills named in it (`/name`, `$name` for
   * Codex), so they reach the agent as the person's words, not inside `flow show`'s output.
   */
  private lineFor(run: RunState, row: OutboxRow): string {
    const p = this.defs.processes[run.process];
    const entry = row.entry_id ? p?.entries.find((e) => e.id === row.entry_id) : undefined;
    const role = p?.roles[row.role];
    if (!role || !row.text.startsWith("▶ flow: step ")) return row.text;
    const refs = lineSkills(entry?.step ? this.defs.steps[entry.step]?.skills ?? [] : [], agentOf(role.spawn));
    return refs.length ? `${row.text} · skills for this step: ${refs.join(" ")} (follow them)` : row.text;
  }

  private codexDir(): string {
    return this.o.codexDir ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  }

  /** Read-only, like claudeTrusts: Codex keeps `[projects."<path>"]` with `trust_level = "trusted"` in config.toml. */
  private codexTrusts(cwd: string): boolean {
    let toml: string;
    try {
      toml = readFileSync(join(this.codexDir(), "config.toml"), "utf8");
    } catch {
      return true;
    }
    let real = cwd;
    try { real = realpathSync(cwd); } catch { /* not there yet */ }
    const trusted = new Set<string>();
    let table: string | null = null;
    for (const line of toml.split("\n")) {
      const head = /^\s*\[(.*)\]\s*$/.exec(line);
      if (head) { table = /^projects\."(.*)"$/.exec(head[1].trim())?.[1] ?? null; continue; }
      if (table !== null && /^\s*trust_level\s*=\s*"trusted"/.test(line)) trusted.add(table);
    }
    return trusted.has(cwd) || trusted.has(real);
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
    const skills = entry.step ? this.defs.steps[entry.step]?.skills ?? [] : [];
    if (skills.length) lines.push(`skills: ${skills.join(", ")} (they came with the step's line; load any you do not have yet)`);
    lines.push("", prompt, "", entry.kind === "human"
      ? `Close it in the UI or with \`flow done --human --run ${shq(run.id)} --step ${entry.id}\``
      : "Report: `flow done [--note …] [--evidence URL]` · `flow failed --note …` · `flow set key=value` · ending your turn to wait on purpose: `flow wait --note …`");
    return { text: lines.join("\n") };
  }

  /** A step's prompt in another language, for the person reading the process (the agent still gets the original). */
  /** (Re)starts the wait before steps are translated ahead; a later change restarts it. */
  private scheduleWarm(ms: number): void {
    if (!this.o.pretranslate?.length || this.closing) return;
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => void this.warm(), ms);
    this.warmTimer.unref();
  }

  /**
   * Translates every step's prompt not yet cached, one at a time and only while no requested
   * translation runs or waits, then drops the cached ones no prompt uses any more. Stops at the
   * first failure (not logged in, a model gone): the next change or restart tries again.
   */
  private async warm(): Promise<void> {
    if (this.warming) { this.warmAgain = true; return; }
    this.warming = true;
    const idle = Math.max(1, Math.round((this.o.pretranslateDelayMs ?? 60_000) / 12));
    try {
      const all = Object.values(this.defs.steps).flatMap((s) => (this.o.pretranslate ?? []).map((lang) => ({ body: s.body, lang })));
      for (const t of all) {
        if (writtenIn(t.body, t.lang)) continue;
        while (this.translator.busy && !this.closing) await new Promise((r) => setTimeout(r, idle));
        if (this.closing) return;
        if (this.translator.isCached(t.body, t.lang)) continue;
        try {
          await this.translator.translate(t.body, t.lang);
        } catch (e) {
          if (!this.closing) this.log(`translating steps ahead stopped: ${msg(e)}`);
          return;
        }
      }
      // a button may have asked for another language: those stay while their prompt is unchanged
      if (!this.warmAgain) this.translator.prune(Object.values(this.defs.steps).flatMap((s) => ["ru", "en", ...(this.o.pretranslate ?? [])].map((lang) => ({ body: s.body, lang }))));
    } finally {
      this.warming = false;
      if (this.warmAgain) { this.warmAgain = false; this.scheduleWarm(this.o.pretranslateDelayMs ?? 60_000); }
    }
  }

  async translateStep(id: string, lang: unknown): Promise<{ text: string } | { error: string; status: number }> {
    if (lang !== "ru" && lang !== "en") return { error: "lang must be ru or en", status: 400 };
    const s = Object.hasOwn(this.defs.steps, id) ? this.defs.steps[id] : undefined;
    if (!s) return { error: `no step ${id}`, status: 404 };
    try {
      return { text: await this.translator.translate(s.body, lang) };
    } catch (e) {
      return { error: `${(e as Error).message}\nThe original text is still there.`, status: 502 };
    }
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

  private queueOf(run: RunState): { position: number; open: number; max: number } {
    const runs = this.store.openRuns().filter((r) => r.process === run.process);
    const p = this.defs.processes[run.process];
    const cap = p ? this.capacity(p, runs) : { open: runs.filter((r) => r.status !== "queued").length, max: 0 };
    return { position: runs.filter((r) => r.status === "queued").findIndex((r) => r.id === run.id) + 1, open: cap.open, max: cap.max };
  }

  /**
   * Whether a process can start another run: its open runs against max_runs and, with max_working, its
   * working ones against that. `open` and `max` are those of the limit people set (working with max_working).
   */
  private capacity(p: Process, runs: RunState[]): { full: boolean; open: number; max: number } {
    const open = runs.filter((r) => r.status !== "queued");
    if (p.maxWorking === undefined) return { full: open.length >= p.maxRuns, open: open.length, max: p.maxRuns };
    const working = open.filter((r) => !this.parked(r)).length;
    return { full: open.length >= p.maxRuns || working >= p.maxWorking, open: working, max: p.maxWorking };
  }

  /**
   * A run nobody works on now: it waits on an event, a hold, a pause entry, a nested run, the person (a
   * human step, flow wait --human, stopped for them, paused). An agent's plain flow wait still counts:
   * its job runs.
   */
  private parked(run: RunState): boolean {
    if (run.status !== "running") return true;
    const cur = this.currentEntry(run);
    const s = cur ? run.entries[cur.id] : undefined;
    return !cur || cur.kind === "human" || cur.kind === "inner" || s?.status === "waiting" || s?.wait?.human === true;
  }

  /** What a person calls the run: see runName. */
  nameOf(run: RunState): string {
    return runName(run, this.defs.processes[run.process]?.label, this.store.runTimes(run.id)?.created ?? this.now());
  }

  runSummary(run: RunState): RunSummary {
    const p = this.defs.processes[run.process];
    const cur = run.current ? p?.entries.find((x) => x.id === run.current) : undefined;
    const s = cur ? run.entries[cur.id] : undefined;
    const times = this.store.runTimes(run.id);
    return {
      id: run.id, name: this.nameOf(run), label: p?.label ?? run.process, process: run.process, asleep: Object.keys(run.asleep ?? {}), iteration: run.iteration, status: run.status, reason: run.reason ?? null,
      current: run.current, currentStatus: s?.status ?? null, currentKind: cur?.kind ?? null,
      waitingOn: s?.status === "waiting" && !s.queued ? cur?.waitFor?.on ?? null : null,
      roles: run.roles, vars: run.vars,
      needsYou: this.needsYou(run),
      agentWait: s?.wait ? { note: s.wait.note, human: s.wait.human, since: s.wait.since } : null,
      waitUntil: cur?.kind === "delay" && s?.status === "waiting" && s.startedAt !== undefined && !s.queued ? s.startedAt + cur.delayMs! : null,
      parent: run.parent?.run ?? null, child: s?.child ?? null,
      heldBy: s?.queued ? { hold: s.queued.hold, run: this.holders()[s.queued.hold] ?? null } : null,
      queue: run.status === "queued" ? this.queueOf(run) : null,
      resumable: p && p.terminal !== "zmx" ? Object.keys(p.roles).filter((r) => agentOf(p.roles[r].spawn) !== "other") : [],
      created: times?.created ?? 0, updated: times?.updated ?? 0,
      plan: (p?.entries ?? []).map((e) => {
        const st = run.entries[e.id];
        return {
          id: e.id, kind: e.kind, role: e.role ?? null, detour: e.detour, waitFor: e.waitFor?.on ?? null,
          status: st?.status ?? "pending", step: e.step ?? null,
          summary: e.step ? this.defs.steps[e.step]?.summary ?? null : null, do: e.do ?? null,
          startedAt: st?.startedAt ?? null, note: st?.note ?? null, onFail: e.onFail, after: e.after ?? null,
          waitMs: e.delayMs ?? null, sh: e.sh ?? null, child: st?.child ?? null,
        };
      }),
    };
  }

  /**
   * Brings back a role's Claude conversation once its session is gone (the run's last step closed
   * it): a new agterm session where it ran, `<spawn> --resume <id>`. The run itself does not change.
   */
  /** The role's Claude or Codex conversation on disk, found by the run's step lines in it. */
  private async conversationOf(run: RunState, role: string, agent: "claude" | "codex"): Promise<{ id: string; cwd: string } | null> {
    const p = this.defs.processes[run.process];
    const entries = (p?.entries ?? []).filter((e) => e.role === role).map((e) => e.id);
    const root = agent === "claude" ? join(this.claudeDir(), "projects") : join(this.codexDir(), "sessions");
    const since = (this.store.runTimes(run.id)?.created ?? 0) - 60_000;
    return (agent === "claude" ? findClaudeSession : findCodexSession)(root, run.id, entries, since);
  }

  /**
   * `pause_on` turned off: every running run of the process pauses, marked as the switch's, and an agent
   * mid-turn on one is stopped (Esc ends the turn and what it runs) and told to tidy up and end its turn.
   * Typed now, not through the outbox, which holds a paused run's lines.
   */
  private async pauseProcess(name: string): Promise<void> {
    if (!this.pausedProcesses.has(name)) this.log(`${name}: paused by its switch`);
    this.pausedProcesses.add(name);
    for (const run of this.store.openRuns().filter((r) => r.process === name && r.status === "running")) {
      if ((await this.apply(run.id, { kind: "pause", by: "pause_on" })).error) continue;
      for (const session of new Set(Object.values(run.roles).filter((s): s is string => Boolean(s)))) {
        const status = this.store.sessionStatus(session);
        if (status !== "active" && status !== "blocked") continue;
        try {
          const term = this.termOf(session);
          await term.press(session, "\x1b");
          await new Promise((r) => setTimeout(r, this.o.pauseKeyDelayMs ?? 1_000));
          await term.type(session, `▶ flow: ${run.id} is paused: ${name}'s switch is off. Stop now: put back anything you changed in the person's setup, then end your turn. flowd tells you when to go on.`);
          this.lastTyped.set(session, this.now());
        } catch (e) {
          this.log(`${run.id}: could not stop the agent in ${session}: ${msg(e)}`);
        }
      }
    }
  }

  /** `pause_on` back on: the runs the switch paused go on; one stopped mid-step is told to carry on. */
  private async resumeProcess(name: string): Promise<void> {
    if (this.pausedProcesses.delete(name)) this.log(`${name}: resumed by its switch`);
    for (const run of this.store.openRuns().filter((r) => r.process === name && r.status === "paused" && r.pausedBy === "pause_on")) {
      if ((await this.apply(run.id, { kind: "resume" })).error) continue;
      const after = this.store.getRun(run.id);
      const cur = after ? this.currentEntry(after) : undefined;
      if (after && cur?.kind === "agent" && cur.role && after.entries[cur.id]?.status === "active") {
        this.store.enqueue(run.id, cur.role, `▶ flow: ${run.id} goes on: the switch is on again. Carry on with step ${cur.id} from where you stopped (\`flow show\` has the instructions).`, null, this.now());
      }
    }
    await this.startQueued();
    void this.flush();
  }

  /** When the run's current entry began to wait: what hibernate measures. */
  private parkedSince(run: RunState): number {
    const cur = this.currentEntry(run);
    const s = cur ? run.entries[cur.id] : undefined;
    return s?.queued?.since ?? (s?.wait?.human ? s.wait.since : undefined) ?? s?.startedAt ?? this.store.runTimes(run.id)?.updated ?? this.now();
  }

  /**
   * `hibernate:` processes only. A run parked longer than its process allows has each idle Claude or
   * Codex agent put to sleep: its conversation recorded in the run, the role unbound, the session
   * closed. The next line to the role resumes it (spawnFor). Never a nested run, one with a run inside,
   * a zmx process or one with split-pane roles.
   */
  private hibernate(): void {
    const now = this.now();
    for (const run of this.store.openRuns()) {
      const p = this.defs.processes[run.process];
      // the entry it is parked on decides, else the process; neither: never (opt-in)
      // a run its process's switch paused sleeps its idle agents at once, whatever hibernate says
      const ms = run.status === "paused" && run.pausedBy === "pause_on" ? 0 : this.currentEntry(run)?.hibernateMs ?? p?.hibernateMs;
      if (!p || ms === undefined || p.terminal === "zmx" || run.parent || run.status === "queued") continue;
      if (Object.values(p.roles).some((r) => r.beside) || this.childOf(run) || !this.parked(run)) continue;
      if (this.parkedSince(run) + ms > now) continue;
      for (const [role, session] of Object.entries(run.roles)) {
        const agent = session && p.roles[role] ? agentOf(p.roles[role].spawn) : "other";
        if (!session || agent === "other" || !["completed", "idle"].includes(this.store.sessionStatus(session) ?? "")) continue;
        const key = `${run.id}\u0000${role}\u0000${session}`;
        if (this.sleeping.has(key)) continue; // under way, or no conversation was found for this session
        this.sleeping.add(key);
        this.background(this.sleepRole(run, role, session, agent, key));
      }
    }
  }

  private async sleepRole(run: RunState, role: string, session: string, agent: "claude" | "codex", key: string): Promise<void> {
    const found = await this.conversationOf(run, role, agent);
    if (!found) { this.log(`${run.id} ${role}: no ${agent} conversation found to resume later; it stays awake`); return; }
    const r = await this.submit({ type: "role.sleep", run: run.id, data: { role, session, agent, conversation: found.id, cwd: found.cwd }, source: "flowd" });
    this.sleeping.delete(key);
    if (r.error) return;
    try {
      await this.agterm.close?.(session);
      this.log(`${run.id} ${role}: asleep (conversation ${found.id}), closed ${session}`);
    } catch (e) {
      this.log(`${run.id} ${role}: asleep, but closing ${session} failed: ${msg(e)}`);
    }
  }

  async restoreSession(runId: string, role: string): Promise<{ session: string } | { error: string }> {
    const run = this.store.getRun(runId);
    if (!run) return { error: `no run ${runId}` };
    const p = this.defs.processes[run.process];
    const r = p?.roles[role];
    if (!p || !r) return { error: `no role ${role} in ${run.process}` };
    const agent = agentOf(r.spawn);
    if (p.terminal === "zmx" || agent === "other") return { error: `${role} is not a Claude or Codex agent in agterm: its conversation cannot be reopened from here` };
    const open = run.roles[role];
    if (open && (await this.agterm.tree()).some((x) => x.id === open)) {
      await this.agterm.focus(open);
      return { session: open };
    }
    const asleep = run.asleep?.[role];
    const found = asleep ? { id: asleep.conversation, cwd: asleep.cwd } : await this.conversationOf(run, role, agent);
    if (!found) return { error: `no conversation of ${run.id} ${role}: ${agent === "claude" ? "Claude" : "Codex"} keeps none, or it was deleted` };
    const name = `${renderTemplate(r.name ?? "{{run.id}} {{role}}", { ...renderData(run), role })}${asleep ? "" : " (restored)"}`;
    const session = await this.agterm.spawn({ cwd: found.cwd, spawn: resumeSpawn(r.spawn, agent, found.id), prompt: "", workspace: p.workspace ?? run.process, window: p.window, name });
    // a sleeping role of an open run is awake again in it
    if (asleep && !TERMINAL.includes(run.status)) await this.submit({ type: "role.bind", run: run.id, data: { role, session, by: "spawn" }, source: "flowd" });
    await this.agterm.focus(session);
    this.log(`${run.id} ${role}: reopened ${agent} session ${found.id} in ${session}`);
    return { session };
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
