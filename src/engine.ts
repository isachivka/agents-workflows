import { renderTemplate, RenderError } from "./template.ts";
import { TERMINAL } from "./types.ts";
import type { Action, Defs, Dict, Entry, EntryState, FlowEvent, Input, Outcome, Process, RunState, StepResult, WaitFor } from "./types.ts";

export const REMIND_AFTER_MS = 30_000;
export const MAX_REMINDERS = 2;
export const COMPACT_TIMEOUT_MS = 600_000;

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
  `▶ flow: step ${entry} is not closed — \`flow done\` or \`flow failed --note "…"\``;

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

export interface StepCtx { process?: Process; defs: Defs; now: number }

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
  }

  const p = ctx.process;
  if (!p) {
    const reason = `process ${run.process} is invalid or missing`;
    if (run.reason !== reason) halt(reason);
    return done();
  }
  for (const e of p.entries) run.entries[e.id] ??= blankEntry();
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
    Object.assign(s, { status: "pending", startedAt: now, deliveredAt: undefined, sawActive: false, remindAt: undefined, reminded: 0 });
    if (e.waitFor) {
      let w: WaitFor;
      try {
        w = { ...e.waitFor, with: renderWith(e.waitFor.with, run) };
      } catch (err) {
        return halt(`${id}: ${errMsg(err)}`);
      }
      s.status = "waiting";
      actions.push({ kind: "watch", entry: id, waitFor: w });
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
    if (info.note !== undefined) s.note = info.note;
    if (info.evidence !== undefined) s.evidence = info.evidence;
    emit(outcome === "done" ? "flow.step.done" : "flow.step.failed", { entry: id, note: info.note ?? "" });
    if (outcome === "done") return advance(id);
    s.failures++;
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
      run.entries[id] = { ...blankEntry(), attempts: old.attempts, failures: old.failures };
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
      if (input.event) st(first.id).event = input.event;
      enter(first.id);
      return done();
    }
    case "report": {
      if (input.entry !== curId) return fail(`step ${input.entry} is not the current step (current: ${curId ?? "none"})`);
      const s = st(curId);
      if (input.by === "agent") {
        if (cur!.kind === "human") return fail(`${curId} is the human's step; the user closes it`);
        if (s.status !== "active") return fail(`step ${curId} is not active (${s.status})`);
        if (s.deliveredAt === undefined) return fail(`step ${curId} has not reached the agent yet`);
      } else if (!["active", "waiting", "failed"].includes(s.status)) {
        return fail(`step ${curId} is ${s.status}`);
      }
      if (input.outcome === "failed" && !input.note && input.by !== "system") return fail("a failure needs --note");
      resume();
      finish(curId, input.outcome, { note: input.note, evidence: input.evidence, by: input.by });
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
      if (input.entry === curId && st(curId).status === "active") st(curId).deliveredAt = now;
      return done();
    }
    // REMAINING-INPUTS (Task 4 replaces this line)
  }
  return done();
}
