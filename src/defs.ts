import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { Cron } from "croner";
import type { Defs, Dict, Entry, OnFail, Process, Role, StepDef, Trigger, WaitFor } from "./types.ts";

export const CORE_EVENTS = [
  "flow.step.done", "flow.step.failed", "flow.iteration.done",
  "flow.run.done", "flow.run.needs-human", "flow.trigger.skipped",
];
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export class DefError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.errors = errors;
  }
}

export interface DefCtx { steps: Record<string, StepDef>; eventTypes: Set<string>; actionNames: Set<string> }
export type DefKind = "process" | "step";

export function flowsHome(): string {
  return process.env.FLOWS_HOME || join(homedir(), ".config", "flows");
}

export function parseDuration(s: unknown): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(String(s));
  if (!m) throw new Error(`bad duration ${JSON.stringify(s)} (use 30s, 10m, 2h, 1d)`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const isObj = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function parseStep(id: string, text: string, source = ""): StepDef {
  const errors: string[] = [];
  if (!NAME_RE.test(id)) errors.push(`step id ${id} must match ${NAME_RE}`);
  const m = FRONTMATTER.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new DefError([...errors, "missing --- frontmatter --- block"]);
  let fm: Dict = {};
  try {
    const parsed = parse(m[1]) ?? {};
    if (isObj(parsed)) fm = parsed;
    else errors.push("frontmatter must be a mapping");
  } catch (e) {
    errors.push(`frontmatter: ${message(e)}`);
  }
  for (const k of Object.keys(fm)) if (k !== "summary") errors.push(`unknown key ${k}`);
  if (typeof fm.summary !== "string" || !fm.summary.trim()) errors.push("summary is required");
  if (!m[2].trim()) errors.push("body is empty");
  if (errors.length) throw new DefError(errors);
  return { id, summary: String(fm.summary).trim(), body: m[2].trim(), source };
}

export function splitStep(text: string): { summary: string; body: string } {
  const m = FRONTMATTER.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { summary: "", body: text };
  let summary = "";
  try {
    const fm = parse(m[1]);
    if (isObj(fm) && typeof fm.summary === "string") summary = fm.summary;
  } catch {
    // lenient: the editor shows whatever is there
  }
  return { summary, body: m[2].trim() };
}

export const PROCESS_KEYS = new Set(["description", "cwd", "repeat", "max_runs", "triggers", "roles", "steps"]);
export const ENTRY_KEYS = new Set(["id", "step", "role", "do", "text", "with", "wait_for", "wait", "sh", "cwd", "on_fail", "retries", "after", "detour", "timeout"]);
const SESSION_ACTIONS = new Set(["clear", "compact", "type"]);

const knownEvent = (type: string, ctx: DefCtx) => ctx.eventTypes.has(type) || /^signal\.[a-z0-9.-]+$/.test(type);

export function parseProcess(name: string, text: string, ctx: DefCtx, source = ""): Process {
  const errors: string[] = [];
  const err = (m: string) => { errors.push(m); };
  if (!NAME_RE.test(name)) err(`process name ${name} must match ${NAME_RE}`);
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new DefError([`yaml: ${message(e)}`]);
  }
  if (!isObj(raw)) throw new DefError(["a process file must be a YAML mapping"]);
  for (const k of Object.keys(raw)) if (!PROCESS_KEYS.has(k)) err(`unknown key ${k}`);

  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) err("description is required");
  const cwd = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
  if (!cwd) err("cwd is required");
  const repeat = raw.repeat ?? false;
  if (typeof repeat !== "boolean") err("repeat must be true or false");
  const maxRuns = raw.max_runs ?? 1;
  if (!Number.isInteger(maxRuns) || (maxRuns as number) < 1) err("max_runs must be an integer >= 1");

  const roles: Record<string, Role> = {};
  if (raw.roles !== undefined && !isObj(raw.roles)) err("roles must be a mapping");
  for (const [r, def] of Object.entries(isObj(raw.roles) ? raw.roles : {})) {
    if (r === "human") { err("role name human is reserved"); continue; }
    if (!isObj(def) || typeof def.spawn !== "string" || !def.spawn.trim()) { err(`role ${r}: spawn is required`); continue; }
    for (const k of Object.keys(def)) if (k !== "spawn" && k !== "cwd") err(`role ${r}: unknown key ${k}`);
    if (def.cwd !== undefined && typeof def.cwd !== "string") err(`role ${r}: cwd must be a string`);
    roles[r] = { spawn: def.spawn, cwd: typeof def.cwd === "string" ? def.cwd : undefined };
  }

  const triggers: Trigger[] = [];
  if (raw.triggers !== undefined && !Array.isArray(raw.triggers)) err("triggers must be a list");
  for (const [i, t] of (Array.isArray(raw.triggers) ? raw.triggers : []).entries()) {
    const at = `trigger ${i + 1}`;
    if (!isObj(t)) { err(`${at}: must be a mapping`); continue; }
    if (typeof t.cron === "string") {
      try {
        new Cron(t.cron, { paused: true }).stop();
      } catch (e) {
        err(`${at}: cron ${t.cron}: ${message(e)}`);
      }
      if (t.with !== undefined) err(`${at}: with only applies to on: triggers`);
      triggers.push({ cron: t.cron, where: {}, with: {} });
    } else if (typeof t.on === "string") {
      if (!knownEvent(t.on, ctx)) err(`${at}: unknown event type ${t.on}`);
      if (t.where !== undefined && !isObj(t.where)) err(`${at}: where must be a mapping`);
      if (t.with !== undefined && !isObj(t.with)) err(`${at}: with must be a mapping`);
      triggers.push({ on: t.on, where: isObj(t.where) ? t.where : {}, with: isObj(t.with) ? t.with : {} });
    } else {
      err(`${at}: needs cron or on`);
    }
  }

  const entries: Entry[] = [];
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) err("steps must be a non-empty list");
  for (const [i, r] of (Array.isArray(raw.steps) ? raw.steps : []).entries()) {
    const at = `steps[${i + 1}]`;
    if (!isObj(r)) { err(`${at}: must be a mapping`); continue; }
    for (const k of Object.keys(r)) if (!ENTRY_KEYS.has(k)) err(`${at}: unknown key ${k}`);

    let waitFor: WaitFor | undefined;
    if (typeof r.wait_for === "string") waitFor = { on: r.wait_for, where: {}, with: {} };
    else if (isObj(r.wait_for) && typeof r.wait_for.on === "string")
      waitFor = { on: r.wait_for.on, where: isObj(r.wait_for.where) ? r.wait_for.where : {}, with: isObj(r.wait_for.with) ? r.wait_for.with : {} };
    else if (r.wait_for !== undefined) err(`${at}: wait_for must be an event type or {on, where, with}`);
    if (waitFor && !knownEvent(waitFor.on, ctx)) err(`${at}: unknown event type ${waitFor.on}`);
    if (r.with !== undefined && !isObj(r.with)) err(`${at}: with must be a mapping`);
    if (isObj(r.wait_for)) {
      for (const k of ["where", "with"]) if (r.wait_for[k] !== undefined && !isObj(r.wait_for[k])) err(`${at}: wait_for.${k} must be a mapping`);
    }

    const role = typeof r.role === "string" ? r.role : undefined;
    let kind: Entry["kind"] = "wait";
    if (r.step !== undefined && r.do !== undefined) err(`${at}: step and do are exclusive`);
    if (typeof r.step === "string") {
      if (!ctx.steps[r.step]) err(`${at}: steps/${r.step}.md is missing or invalid`);
      if (!role) err(`${at}: step needs a role`);
      else if (role !== "human" && !roles[role]) err(`${at}: undeclared role ${role}`);
      kind = role === "human" ? "human" : "agent";
    } else if (typeof r.do === "string") {
      kind = "action";
      if (SESSION_ACTIONS.has(r.do)) {
        if (!role || !roles[role]) err(`${at}: do: ${r.do} needs a declared agent role`);
        if (r.do === "type" && typeof r.text !== "string") err(`${at}: do: type needs text`);
      } else if (!ctx.actionNames.has(r.do)) {
        err(`${at}: unknown action ${r.do}`);
      }
    } else if (!waitFor && r.wait === undefined && r.sh === undefined) {
      err(`${at}: needs step, do, wait_for, wait or sh`);
    }
    let sh: string | undefined;
    if (r.sh !== undefined) {
      if (typeof r.sh !== "string" || !r.sh.trim()) err(`${at}: sh must be a command`);
      else if (r.step !== undefined || r.do !== undefined || r.wait !== undefined || r.role !== undefined) {
        err(`${at}: sh runs on its own; it cannot go with step, do, wait or role`);
      } else {
        kind = "action";
        sh = r.sh;
      }
    }
    if (r.cwd !== undefined && (r.sh === undefined || typeof r.cwd !== "string")) err(`${at}: cwd on a step is only for sh, and must be a path`);
    let delayMs: number | undefined;
    if (r.wait !== undefined) {
      if (r.step !== undefined || r.do !== undefined || waitFor) err(`${at}: wait is a pause on its own; it cannot go with step, do or wait_for`);
      else kind = "delay";
      try {
        delayMs = parseDuration(r.wait);
      } catch (e) {
        err(`${at}: ${message(e)}`);
      }
    }

    let onFail: OnFail = "human";
    if (r.on_fail === "retry" || r.on_fail === "human") onFail = r.on_fail;
    else if (isObj(r.on_fail) && typeof r.on_fail.goto === "string") onFail = { goto: r.on_fail.goto };
    else if (r.on_fail !== undefined) err(`${at}: on_fail must be retry, human or {goto: id}`);

    const retries = r.retries ?? 3;
    if (!Number.isInteger(retries) || (retries as number) < 0) err(`${at}: retries must be an integer >= 0`);

    let after: { goto: string } | undefined;
    if (isObj(r.after) && typeof r.after.goto === "string") after = { goto: r.after.goto };
    else if (r.after !== undefined) err(`${at}: after must be {goto: id}`);

    const detour = r.detour ?? false;
    if (typeof detour !== "boolean") err(`${at}: detour must be true or false`);
    if (detour === true && !after) err(`${at}: a detour needs after.goto`);

    let timeoutMs: number | undefined;
    if (r.timeout !== undefined) {
      try {
        timeoutMs = parseDuration(r.timeout);
      } catch (e) {
        err(`${at}: ${message(e)}`);
      }
    }

    const id = typeof r.id === "string" ? r.id : String(r.step ?? r.do ?? waitFor?.on ?? (r.wait !== undefined ? "wait" : r.sh !== undefined ? "sh" : `entry-${i + 1}`));
    entries.push({
      id, kind,
      step: typeof r.step === "string" ? r.step : undefined,
      role,
      do: typeof r.do === "string" ? r.do : undefined,
      text: typeof r.text === "string" ? r.text : undefined,
      with: isObj(r.with) ? r.with : {},
      waitFor, onFail, retries: retries as number, after, detour: detour === true, timeoutMs, delayMs,
      sh, cwd: sh !== undefined && typeof r.cwd === "string" ? r.cwd : undefined,
    });
  }

  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) err(`duplicate entry id ${e.id} (give one an explicit id)`);
    ids.add(e.id);
  }
  for (const e of entries) {
    for (const target of [typeof e.onFail === "object" ? e.onFail.goto : undefined, e.after?.goto]) {
      if (target !== undefined && !ids.has(target)) err(`${e.id}: goto target ${target} does not exist`);
    }
  }
  if (entries.length && entries.every((e) => e.detour)) err("at least one entry must not be a detour");
  // the engine hands an entry an event only when it waits for one (and an agent or action then starts;
  // a human step is closed by it), or as the first entry of a run an on: trigger started; a repeating
  // run's later iterations start with fresh entries and no event
  const first = entries.find((e) => !e.detour);
  const triggered = triggers.some((t) => t.on) && repeat !== true;
  for (const e of entries) {
    const text = e.step ? ctx.steps[e.step]?.body : e.text;
    const woken = e.waitFor && e.kind !== "human";
    if (!woken && !(triggered && e === first) && /\{\{\s*event\./.test(text ?? "")) {
      err(`${e.id}: ${e.step ? `step ${e.step}` : "text"} uses {{event.*}}, but only an agent step or action with wait_for (or the first entry of a non-repeating run an on: trigger started) gets an event`);
    }
  }
  if (errors.length) throw new DefError(errors);
  return { name, description, cwd, repeat: repeat as boolean, maxRuns: maxRuns as number, triggers, roles, entries, source };
}

const files = (dir: string, ext: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ext)).sort() : []);
const errorsOf = (e: unknown) => (e instanceof DefError ? e.errors : [message(e)]);

export function loadDefs(home: string, eventTypes: Set<string>, actionNames: Set<string>): Defs {
  const defs: Defs = { processes: {}, steps: {}, invalid: {} };
  for (const f of files(join(home, "steps"), ".md")) {
    const id = basename(f, ".md");
    const path = join(home, "steps", f);
    try {
      defs.steps[id] = parseStep(id, readFileSync(path, "utf8"), path);
    } catch (e) {
      defs.invalid[`step:${id}`] = errorsOf(e);
    }
  }
  const ctx: DefCtx = { steps: defs.steps, eventTypes, actionNames };
  for (const f of files(join(home, "processes"), ".yaml")) {
    const name = basename(f, ".yaml");
    const path = join(home, "processes", f);
    try {
      defs.processes[name] = parseProcess(name, readFileSync(path, "utf8"), ctx, path);
    } catch (e) {
      defs.invalid[`process:${name}`] = errorsOf(e);
    }
  }
  return defs;
}

export function defPath(home: string, kind: DefKind, name: string): string {
  return kind === "step" ? join(home, "steps", `${name}.md`) : join(home, "processes", `${name}.yaml`);
}

export function readDef(home: string, kind: DefKind, name: string): { text: string; mtime: number } | null {
  if (!NAME_RE.test(name)) return null;
  const path = defPath(home, kind, name);
  if (!existsSync(path)) return null;
  return { text: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs };
}

const CHANGED = "the file changed on disk; reload it";

export function writeDef(home: string, kind: DefKind, name: string, text: string, baseMtime: number | null, ctx: DefCtx):
  { ok: true; mtime: number } | { ok: false; status: 409 | 422; errors: string[] } {
  if ((readDef(home, kind, name)?.mtime ?? null) !== baseMtime) return { ok: false, status: 409, errors: [CHANGED] };
  try {
    if (kind === "step") parseStep(name, text);
    else parseProcess(name, text, ctx);
  } catch (e) {
    return { ok: false, status: 422, errors: errorsOf(e) };
  }
  const path = defPath(home, kind, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
  return { ok: true, mtime: statSync(path).mtimeMs };
}

export function deleteDef(home: string, kind: DefKind, name: string, baseMtime: number | null):
  { ok: true } | { ok: false; status: 404 | 409; errors: string[] } {
  const cur = readDef(home, kind, name);
  if (!cur) return { ok: false, status: 404, errors: [`no ${kind} ${name}`] };
  if (cur.mtime !== baseMtime) return { ok: false, status: 409, errors: [CHANGED] };
  unlinkSync(defPath(home, kind, name));
  return { ok: true };
}
