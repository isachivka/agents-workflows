export type Dict = Record<string, unknown>;
export type Outcome = "done" | "failed";

export interface WaitFor { on: string; where: Dict; with: Dict }
export type OnFail = "retry" | "human" | { goto: string };
export type EntryKind = "agent" | "human" | "action" | "wait";

export interface Entry {
  id: string;
  kind: EntryKind;
  step?: string;
  role?: string;
  do?: string;
  text?: string;
  with: Dict;
  waitFor?: WaitFor;
  onFail: OnFail;
  retries: number;
  after?: { goto: string };
  detour: boolean;
  timeoutMs?: number;
}

export interface Role { spawn: string; cwd?: string }
export interface Trigger { cron?: string; on?: string; where: Dict; with: Dict }

export interface Process {
  name: string;
  description: string;
  cwd: string;
  repeat: boolean;
  maxRuns: number;
  triggers: Trigger[];
  roles: Record<string, Role>;
  entries: Entry[];
  source: string;
}

export interface StepDef { id: string; summary: string; body: string; source: string }

export interface Defs {
  processes: Record<string, Process>;
  steps: Record<string, StepDef>;
  /** "process:<name>" | "step:<id>" → validation errors */
  invalid: Record<string, string[]>;
}

export interface FlowEvent {
  id?: number;
  type: string;
  outcome?: Outcome;
  data: Dict;
  run?: string;
  entry?: string;
  source: string;
}

export type EntryStatus = "pending" | "waiting" | "active" | "done" | "failed" | "skipped";

export interface EntryState {
  status: EntryStatus;
  attempts: number;
  failures: number;
  note?: string;
  evidence?: string;
  by?: string;
  event?: FlowEvent;
  startedAt?: number;
  deliveredAt?: number;
  sawActive: boolean;
  remindAt?: number;
  reminded: number;
}

export type RunStatus = "running" | "paused" | "needs-human" | "done" | "stopped";
export const TERMINAL: RunStatus[] = ["done", "stopped"];

export interface RunState {
  id: string;
  process: string;
  iteration: number;
  status: RunStatus;
  reason?: string;
  vars: Record<string, string>;
  roles: Record<string, string | null>;
  entries: Record<string, EntryState>;
  current: string | null;
}

export type SessionStatus = "active" | "completed" | "idle" | "blocked" | "closed";

export type Input =
  | { kind: "start"; event?: FlowEvent }
  | { kind: "report"; entry: string; outcome: Outcome; note?: string; evidence?: string; by: "agent" | "human" | "system" }
  | { kind: "skip"; entry: string; note: string }
  | { kind: "goto"; entry: string }
  | { kind: "retry"; entry: string }
  | { kind: "event"; event: FlowEvent }
  | { kind: "session"; session: string; status: SessionStatus }
  | { kind: "compacted"; session: string }
  | { kind: "tick" }
  | { kind: "set"; vars: Record<string, string> }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }
  | { kind: "bind"; role: string; session: string | null; by: "spawn" | "human" }
  | { kind: "respawn"; role: string }
  | { kind: "halt"; reason: string }
  | { kind: "delivered"; entry: string };

export type Action =
  | { kind: "deliver"; role: string; text: string; entry?: string }
  | { kind: "watch"; entry: string; waitFor: WaitFor }
  | { kind: "unwatch"; entry: string }
  | { kind: "plugin-action"; entry: string; name: string; with: Dict }
  | { kind: "emit"; event: FlowEvent };

export interface StepResult { run: RunState; actions: Action[]; error?: string }
