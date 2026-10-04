import { parseProcess, parseStep, type DefCtx } from "../src/defs.ts";
import { newRun, step } from "../src/engine.ts";
import type { Action, Defs, Input, Process, RunState } from "../src/types.ts";

export const EVENT_TYPES = new Set(["gh.checks", "gh.merged", "flow.iteration.done", "flow.run.done", "test.ping"]);

export function mkDefs(yaml: string, steps: Record<string, string> = {}, name = "p"): { process: Process; defs: Defs } {
  const stepDefs = Object.fromEntries(
    Object.entries(steps).map(([id, body]) => [id, parseStep(id, `---\nsummary: ${id}\n---\n${body}\n`)]),
  );
  const ctx: DefCtx = { steps: stepDefs, eventTypes: EVENT_TYPES, actionNames: new Set(["test.post"]) };
  const process = parseProcess(name, yaml, ctx);
  return { process, defs: { processes: { [name]: process }, steps: stepDefs, invalid: {} } };
}

/** Drives one run through the pure engine and keeps the last result. */
export class Sim {
  process: Process | undefined;
  defs: Defs;
  run: RunState;
  actions: Action[] = [];
  error: string | undefined;
  now = 1_000_000;
  /** The daemon reports `delivered` once a nudge is typed; the simulator does it at once. */
  autoDeliver = true;

  constructor(yaml: string, steps: Record<string, string> = {}, bind: Record<string, string> = {}) {
    const { process, defs } = mkDefs(yaml, steps);
    this.process = process;
    this.defs = defs;
    this.run = newRun("p#1", process, bind);
  }

  send(input: Input): this {
    const ctx = { process: this.process, defs: this.defs, now: this.now };
    const r = step(this.run, input, ctx);
    this.run = r.run;
    this.actions = r.actions;
    this.error = r.error;
    if (this.autoDeliver) {
      for (const a of r.actions) if (a.kind === "deliver" && a.entry) this.run = step(this.run, { kind: "delivered", entry: a.entry }, ctx).run;
    }
    return this;
  }

  status(id: string) { return this.run.entries[id]?.status; }
  delivered(): string[] { return this.actions.flatMap((a) => (a.kind === "deliver" ? [`${a.role}: ${a.text}`] : [])); }
  emitted(): string[] { return this.actions.flatMap((a) => (a.kind === "emit" ? [a.event.type] : [])); }
  kinds(): string[] { return this.actions.map((a) => a.kind); }
}

export const rep = (entry: string, outcome: "done" | "failed" = "done", by: "agent" | "human" | "system" = "agent", note?: string): Input =>
  ({ kind: "report", entry, outcome, by, note });

export const nudge = (role: string, entry: string, it = 1) =>
  `${role}: ▶ flow: step ${entry} · p#1 it.${it} — run \`flow show\` for the instructions`;
