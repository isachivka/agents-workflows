import { renderTemplate, RenderError } from "./template.ts";
import { TERMINAL } from "./types.ts";
import type { Action, Defs, Dict, Entry, EntryState, FlowEvent, Input, Outcome, Process, RunState, StepResult, WaitFor } from "./types.ts";

export const REMIND_AFTER_MS = 30_000;
export const MAX_REMINDERS = 2;
export const COMPACT_TIMEOUT_MS = 600_000;
export const START_TIMEOUT_MS = 120_000;
export const SHELL_TIMEOUT_MS = 1_800_000;

const envName = (k: string) => k.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

/** What a shell entry sees of the run: env vars only, so no outside value is ever run as code. */
export function shellEnv(run: RunState, event?: FlowEvent): Record<string, string> {
  const env: Record<string, string> = { FLOW_RUN: run.id, FLOW_PROCESS: run.process, FLOW_ITERATION: String(run.iteration) };
  for (const [k, v] of Object.entries(run.vars)) env[`FLOW_VAR_${envName(k)}`] = v;
  for (const [k, v] of Object.entries(event?.data ?? {})) {
    if (v !== null && v !== undefined && typeof v !== "object") env[`FLOW_EVENT_${envName(k)}`] = String(v);
  }
  return env;
}

/** 86400000 → "1d", 5400000 → "90m": the largest whole unit, as `wait:` and `timeout:` take it. */
export function formatDuration(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

export const notStartedText = (entry: string) =>
  `${entry}: the agent has not started 2 min after its line was delivered — look at its terminal (a trust or login prompt, an error)`;

export const blankEntry = (): EntryState => ({ status: "pending", attempts: 0, failures: 0, sawActive: false, reminded: 0 });

export function newRun(id: string, p: Process, bind: Record<string, string> = {}): RunState {
  const roles: Record<string, string | null> = {};
  for (const r of Object.keys(p.roles)) roles[r] = bind[r] ?? null;
  const entries: Record<string, EntryState> = {};
  for (const e of p.entries) entries[e.id] = blankEntry();
  return { id, process: p.name, iteration: 1, status: "running", vars: {}, roles, entries, current: null };
}

export const nudgeText = (run: RunState, entry: string) =>
  `▶ flow: step ${entry} · ${run.id} it.${run.iteration} — run \`flow show\` for the instructions`;

export const reminderText = (entry: string) =>
  `▶ flow: step ${entry} is not closed — \`flow done\`, \`flow failed --note "…"\`, or \`flow wait --note "…"\` if you are waiting on purpose`;

export function renderData(run: RunState, event?: FlowEvent): Dict {
  return {
    run: { id: run.id, process: run.process, iteration: run.iteration },
    vars: run.vars,
    event: event ? { type: event.type, outcome: event.outcome, data: event.data } : undefined,
  };
}

export function renderPrompt(run: RunState, entry: Entry, defs: Defs): string {
  const def = entry.step ? defs.steps[entry.step] : undefined;
  if (!def) throw new RenderError(`step file ${entry.step}.md is missing or invalid`);
  return renderTemplate(def.body, renderData(run, run.entries[entry.id]?.event));
}

export function renderWith(w: Dict, run: RunState): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(w)) out[k] = typeof v === "string" ? renderTemplate(v, renderData(run)) : v;
  return out;
}

export function matches(where: Dict, data: Dict): boolean {
  return Object.entries(where).every(([k, v]) => data[k] !== undefined && String(data[k]) === String(v));
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** holders: which open run stands on an entry holding each name (from the daemon) */
export interface StepCtx { process?: Process; defs: Defs; now: number; holders?: Record<string, string> }

export function step(prev: RunState, input: Input, ctx: StepCtx): StepResult {
  if (TERMINAL.includes(prev.status)) return { run: prev, actions: [], error: `run ${prev.id} is ${prev.status}` };
  const run: RunState = structuredClone(prev);
  const actions: Action[] = [];
  const { defs, now } = ctx;
  const fail = (error: string): StepResult => ({ run: prev, actions: [], error });
  const done = (): StepResult => ({ run, actions });

  const emit = (type: string, data: Dict = {}) => {
    actions.push({ kind: "emit", event: { type, data: { process: run.process, run: run.id, ...data }, source: "flow" } });
  };
  const halt = (reason: string) => {
    run.status = "needs-human";
    run.reason = reason;
    emit("flow.run.needs-human", { reason });
  };
  const resume = () => {
    if (run.status === "needs-human") {
      run.status = "running";
      run.reason = undefined;
      run.startBlocked = undefined;
    }
  };

  // inputs that do not need a valid process definition
  switch (input.kind) {
    case "stop": {
      if (run.current && run.entries[run.current]?.status === "waiting") actions.push({ kind: "unwatch", entry: run.current });
      run.status = "stopped";
      return done();
    }
    case "pause":
      if (run.status !== "running") return fail(`only a running run can be paused (this one is ${run.status})`);
      run.status = "paused";
      return done();
    case "resume":
      if (run.status !== "paused") return fail(`run ${run.id} is not paused`);
      run.status = "running";
      return done();
    case "set":
      Object.assign(run.vars, input.vars);
      return done();
    case "halt":
      halt(input.reason);
      return done();
    case "start-blocked":
      if (input.entry !== run.current) return done();
      run.entries[input.entry].startBy = undefined;
      halt(input.reason);
      run.startBlocked = input.entry;
      return done();
  }

  const p = ctx.process;
  if (!p) {
    const reason = `process ${run.process} is invalid or missing`;
    if (run.reason !== reason) halt(reason);
    return done();
  }
  for (const e of p.entries) run.entries[e.id] ??= blankEntry();
  for (const r of Object.keys(p.roles)) if (!(r in run.roles)) run.roles[r] = null;
  const byId = (id: string) => p.entries.find((e) => e.id === id);
  const st = (id: string) => run.entries[id];
  const deliver = (role: string, text: string, entry?: string) => {
    actions.push(entry ? { kind: "deliver", role, text, entry } : { kind: "deliver", role, text });
  };
  let iterationsEnded = 0;

  function enter(id: string): void {
    const e = byId(id)!;
    const s = st(id);
    run.current = id;
    Object.assign(s, { status: "pending", startedAt: now, deliveredAt: undefined, sawActive: false, remindAt: undefined, reminded: 0, wait: undefined, startBy: undefined, queued: undefined });
    proceed(id);
  }

  /** What entering does once the entry's hold, if any, is this run's. */
  function proceed(id: string): void {
    const e = byId(id)!;
    const s = st(id);
    const holder = e.hold ? ctx.holders?.[e.hold] : undefined;
    if (holder && holder !== run.id) {
      s.status = "waiting";
      s.queued = { hold: e.hold!, since: now };
      return;
    }
    if (e.kind === "delay") {
      s.status = "waiting"; // the tick closes it once startedAt + delayMs has passed
      return;
    }
    if (e.waitFor) {
      let w: WaitFor;
      try {
        w = { ...e.waitFor, with: renderWith(e.waitFor.with, run) };
      } catch (err) {
        return halt(`${id}: ${errMsg(err)}`);
      }
      s.status = "waiting";
      // a re-armed wait (retry, or a goto back within the iteration) learns what last woke it, so a
      // plugin can avoid firing again on that same thing; a new iteration starts without it
      const prev = s.woke?.type === w.on ? s.woke : undefined;
      actions.push(prev ? { kind: "watch", entry: id, waitFor: w, previous: prev } : { kind: "watch", entry: id, waitFor: w });
      return;
    }
    begin(id);
  }

  function begin(id: string): void {
    const e = byId(id)!;
    const s = st(id);
    s.status = "active";
    s.attempts++;
    s.startedAt = now;
    if (e.kind === "agent") {
      try {
        renderPrompt(run, e, defs);
      } catch (err) {
        return halt(`${id}: ${errMsg(err)}`);
      }
      deliver(e.role!, nudgeText(run, id), id); // deliveredAt is set by the "delivered" input once it is typed
      return;
    }
    if (e.kind === "human" || e.kind === "wait") return;
    if (e.do === "clear" || e.do === "compact") {
      if (!run.roles[e.role!]) return finish(id, "done", { note: `fresh session, no ${e.do} needed`, by: "system" });
      deliver(e.role!, `/${e.do}`);
      if (e.do === "clear") finish(id, "done", { by: "system" });
      return; // compact finishes on the "compacted" input
    }
    if (e.do === "type") {
      let text: string;
      try {
        text = renderTemplate(e.text ?? "", renderData(run, s.event));
      } catch (err) {
        return halt(`${id}: ${errMsg(err)}`);
      }
      deliver(e.role!, text);
      return finish(id, "done", { by: "system" });
    }
    if (e.sh !== undefined) {
      let cwd: string;
      try {
        cwd = e.cwd ? renderTemplate(e.cwd, renderData(run)) : p!.cwd;
      } catch (err) {
        return halt(`${id}: ${errMsg(err)}`);
      }
      actions.push({ kind: "shell", entry: id, command: e.sh, cwd, env: shellEnv(run, s.event), timeoutMs: e.timeoutMs ?? SHELL_TIMEOUT_MS });
      return;
    }
    let args: Dict;
    try {
      args = renderWith(e.with, run);
    } catch (err) {
      return halt(`${id}: ${errMsg(err)}`);
    }
    actions.push({ kind: "plugin-action", entry: id, name: e.do!, with: args });
  }

  function finish(id: string, outcome: Outcome, info: { note?: string; evidence?: string; by: string }): void {
    const e = byId(id)!;
    const s = st(id);
    if (s.status === "waiting") actions.push({ kind: "unwatch", entry: id });
    s.status = outcome;
    s.by = info.by;
    s.remindAt = undefined;
    s.wait = undefined;
    if (info.note !== undefined) s.note = info.note;
    if (info.evidence !== undefined) s.evidence = info.evidence;
    emit(outcome === "done" ? "flow.step.done" : "flow.step.failed", { entry: id, note: info.note ?? "" });
    if (outcome === "done") return advance(id);
    s.failures++;
    // end is the process's own "nothing to do here": no human, and retries does not apply
    if (e.onFail === "end") return endIteration();
    const why = info.note ? `: ${info.note}` : "";
    if (s.failures > e.retries) return halt(`${id} failed ${s.failures} times${why}`);
    if (e.onFail === "human") return halt(`${id} failed${why}`);
    if (e.onFail === "retry") return enter(id);
    jump(id, e.onFail.goto);
  }

  function advance(from: string): void {
    const e = byId(from)!;
    if (e.after) return jump(from, e.after.goto);
    const next = p!.entries.slice(p!.entries.indexOf(e) + 1).find((x) => !x.detour);
    if (next) return enter(next.id);
    endIteration();
  }

  function jump(from: string, to: string): void {
    const ids = p!.entries.map((x) => x.id);
    const fi = ids.indexOf(from);
    const ti = ids.indexOf(to);
    for (const id of ti <= fi ? ids.slice(ti, fi + 1) : [to]) {
      const old = st(id);
      run.entries[id] = { ...blankEntry(), attempts: old.attempts, failures: old.failures, woke: old.woke };
    }
    enter(to);
  }

  function endIteration(): void {
    if (!p!.repeat) {
      run.status = "done";
      run.current = null;
      emit("flow.run.done", { iteration: run.iteration });
      return;
    }
    if (++iterationsEnded > 1) return halt("an iteration finished without waiting for anything; it did no work");
    emit("flow.iteration.done", { iteration: run.iteration });
    run.iteration++;
    run.vars = {};
    for (const e of p!.entries) run.entries[e.id] = blankEntry();
    enter(p!.entries.find((x) => !x.detour)!.id);
  }

  function recover(role: string): void {
    const redeliver = cur?.role === role && cur.kind === "agent" && st(cur.id).status === "active";
    // only a halt this role caused is lifted; a failed step of another role stays with the human
    if (redeliver || run.reason?.startsWith(`role ${role} `)) resume();
    if (!redeliver) return;
    const s = st(cur.id);
    s.deliveredAt = undefined;
    s.sawActive = false;
    s.reminded = 0;
    s.remindAt = undefined;
    s.wait = undefined;
    deliver(role, nudgeText(run, cur.id), cur.id);
  }

  const curId = run.current;
  const cur = curId ? byId(curId) : undefined;
  if (curId && !cur && input.kind !== "goto" && input.kind !== "bind" && input.kind !== "respawn") {
    const reason = `entry ${curId} no longer exists`;
    if (run.reason !== reason) halt(reason);
    return done();
  }

  switch (input.kind) {
    case "start": {
      if (curId) return fail(`run ${run.id} already started`);
      const first = p.entries.find((x) => !x.detour)!;
      if (input.event) {
        st(first.id).event = input.event;
        // the run knows what started it: scalar event data become vars, plus the event type
        for (const [k, v] of Object.entries(input.event.data)) {
          if (v !== null && v !== undefined && typeof v !== "object") run.vars[k] = String(v);
        }
        run.vars.trigger = input.event.type;
      }
      enter(first.id);
      return done();
    }
    case "report": {
      if (input.entry !== curId) return fail(`step ${input.entry} is not the current step (current: ${curId ?? "none"})`);
      const s = st(curId);
      if (input.by === "agent") {
        if (cur!.kind === "human") return fail(`${curId} is the human's step; a human closes it`);
        // its own failed step is still current only when the run stopped on it; the agent gets a
        // turn then only because the user talks to it, so its report carries the user's decision
        if (s.status !== "active" && s.status !== "failed") return fail(`step ${curId} is not active (${s.status})`);
        if (s.deliveredAt === undefined) return fail(`step ${curId} has not reached the agent yet`);
      } else if (!["active", "waiting", "failed"].includes(s.status)) {
        return fail(`step ${curId} is ${s.status}`);
      }
      if (input.outcome === "failed" && !input.note && input.by !== "system") return fail("a failure needs --note");
      resume();
      finish(curId, input.outcome, { note: input.note, evidence: input.evidence, by: input.by });
      return done();
    }
    case "wait": {
      if (input.entry !== curId) return fail(`step ${input.entry} is not the current step (current: ${curId ?? "none"})`);
      const s = st(curId);
      if (cur!.kind !== "agent") return fail(`flow wait is for an agent's step; ${curId} is a ${cur!.kind} step`);
      if (s.status !== "active") return fail(`step ${curId} is not active (${s.status})`);
      if (s.deliveredAt === undefined) return fail(`step ${curId} has not reached the agent yet`);
      if (!input.note) return fail("flow wait needs --note saying what you are waiting for");
      // declared mid-turn it parks on the turn end; declared after the turn (or from another
      // terminal) no turn end will follow, so it is parked already
      s.wait = { note: input.note, human: input.human, since: now, parked: !input.sessionActive };
      s.reminded = 0;
      s.remindAt = undefined;
      return done();
    }
    case "skip": {
      if (input.entry !== curId) return fail(`step ${input.entry} is not the current step (current: ${curId ?? "none"})`);
      if (!input.note) return fail("a skip needs a reason");
      const s = st(curId);
      if (s.status === "waiting") actions.push({ kind: "unwatch", entry: curId });
      s.status = "skipped";
      s.note = input.note;
      s.by = "human";
      resume();
      advance(curId);
      return done();
    }
    case "goto": {
      if (!byId(input.entry)) return fail(`no entry ${input.entry} in ${p.name}`);
      if (curId && st(curId)?.status === "waiting") actions.push({ kind: "unwatch", entry: curId });
      resume();
      jump(cur ? curId! : input.entry, input.entry);
      return done();
    }
    case "retry": {
      if (input.entry !== curId) return fail(`step ${input.entry} is not the current step (current: ${curId ?? "none"})`);
      if (st(curId).status === "waiting") actions.push({ kind: "unwatch", entry: curId });
      resume();
      enter(curId);
      return done();
    }
    case "delivered": {
      if (input.entry === curId && st(curId).status === "active") {
        const s = st(curId);
        s.deliveredAt = now;
        // an active seen after this line was queued means the turn already started
        if (!s.sawActive) s.startBy = now + START_TIMEOUT_MS;
      }
      return done();
    }
    case "event": {
      if (!cur || !cur.waitFor || st(cur.id).status !== "waiting") return done();
      const ev = input.event;
      if (ev.type !== cur.waitFor.on || (ev.entry && ev.entry !== cur.id) || !matches(cur.waitFor.where, ev.data)) return done();
      st(cur.id).event = ev;
      st(cur.id).woke = { type: ev.type, data: ev.data };
      if (cur.kind === "agent" || cur.kind === "action") {
        actions.push({ kind: "unwatch", entry: cur.id });
        begin(cur.id);
      } else {
        finish(cur.id, ev.outcome === "failed" ? "failed" : "done", { note: `${ev.type}${ev.outcome ? ` ${ev.outcome}` : ""}`, by: "system" });
      }
      return done();
    }
    case "session": {
      const roles = Object.keys(run.roles).filter((r) => run.roles[r] === input.session);
      if (!roles.length) return done();
      const busy = cur && roles.includes(cur.role ?? "") && cur.kind !== "human" && st(cur.id).status === "active";
      if (input.status === "closed") {
        for (const r of roles) run.roles[r] = null;
        if (busy) halt(`role ${cur!.role} session closed`);
        return done();
      }
      if (!busy || cur!.kind !== "agent") return done();
      const s = st(cur!.id);
      if (!s.deliveredAt) return done();
      if (input.status === "active") {
        if (s.wait?.parked) s.wait = undefined; // the agent's next turn began: the wait is used up
        s.sawActive = true;
        s.remindAt = undefined;
        s.startBy = undefined;
        if (run.startBlocked === cur!.id) resume(); // the prompt that held it was answered
      } else if (input.status === "completed") {
        // only completed ends a turn: idle is agterm clearing the status (the user pressed a key, a session started)
        if (s.wait) {
          s.wait.parked = true; // the turn the wait was declared in ended; repeats change nothing
          s.remindAt = undefined;
        } else if (s.sawActive) {
          s.remindAt = now + REMIND_AFTER_MS;
        }
      }
      return done();
    }
    case "compacted": {
      if (cur?.do === "compact" && st(cur.id).status === "active" && run.roles[cur.role!] === input.session) {
        finish(cur.id, "done", { by: "system" });
      }
      return done();
    }
    case "hold-free": {
      if (run.status !== "running" || !cur || !st(cur.id).queued) return fail(`${run.id} is not queued for a hold`);
      const s = st(cur.id);
      s.queued = undefined;
      s.startedAt = now;
      proceed(cur.id);
      return done();
    }
    case "tick": {
      if (run.status !== "running" || !cur) return done();
      const s = st(cur.id);
      if (s.status !== "active" && s.status !== "waiting") return done();
      if (s.queued) return done(); // its timeout starts once it has the hold
      if (cur.kind === "delay" && s.status === "waiting" && s.startedAt !== undefined && now - s.startedAt >= cur.delayMs!) {
        finish(cur.id, "done", { note: `waited ${formatDuration(cur.delayMs!)}`, by: "system" });
        return done();
      }
      const timeout = cur.timeoutMs ?? (cur.do === "compact" ? COMPACT_TIMEOUT_MS : undefined);
      if (timeout !== undefined && s.startedAt !== undefined && now - s.startedAt >= timeout) {
        finish(cur.id, "failed", { note: `timed out after ${timeout / 1000}s`, by: "system" });
        return done();
      }
      if (cur.kind === "agent" && s.status === "active" && !s.wait && s.startBy !== undefined && now >= s.startBy) {
        s.startBy = undefined;
        halt(notStartedText(cur.id));
        run.startBlocked = cur.id;
        return done();
      }
      if (s.remindAt !== undefined && now >= s.remindAt) {
        s.remindAt = undefined;
        if (s.reminded >= MAX_REMINDERS) {
          halt(`${cur.id}: the agent ended its turn ${s.reminded + 1} times without flow done/failed`);
        } else {
          s.reminded++;
          s.sawActive = false;
          deliver(cur.role!, reminderText(cur.id), cur.id);
        }
      }
      return done();
    }
    case "bind": {
      if (!(input.role in run.roles)) return fail(`${p.name} has no role ${input.role}`);
      run.roles[input.role] = input.session;
      if (input.by === "human") recover(input.role);
      return done();
    }
    case "respawn": {
      if (!(input.role in run.roles)) return fail(`${p.name} has no role ${input.role}`);
      run.roles[input.role] = null;
      recover(input.role);
      return done();
    }
  }
  return done();
}
