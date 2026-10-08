export type Dict = Record<string, unknown>;
export type Outcome = "done" | "failed";

export interface WaitFor { on: string; where: Dict; with: Dict }
export type OnFail = "retry" | "human" | "end" | { goto: string };
export type EntryKind = "agent" | "human" | "action" | "wait" | "delay";

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
  /** a pause entry (`wait: 24h`): how long it waits before it is done */
  delayMs?: number;
  /** a shell entry: the command flowd runs, as written (never templated) */
  sh?: string;
  /** a shell entry's working directory (a template); else the process cwd */
  cwd?: string;
  /** a name only one open run at a time may stand on (`hold: desk-1`); the others queue */
  hold?: string;
}

/** name: the agterm session name, a template over run and role (default "{{run.id}} {{role}}") */
export interface Role { spawn: string; cwd?: string; name?: string }
export interface Trigger { cron?: string; on?: string; where: Dict; with: Dict }

export interface Process {
  name: string;
  description: string;
  cwd: string;
  repeat: boolean;
  maxRuns: number;
  /** the agterm workspace its roles spawn into (default: the process name) */
  workspace?: string;
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
  /** Set when a trigger subscription emitted it: only that subscription's processes may start. */
  subscription?: string;
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
  /** set when a line is delivered: the agent must go active by then */
  startBy?: number;
  /** entered while another run had its hold: waits for the daemon's hold-free */
  queued?: { hold: string; since: number };
  reminded: number;
  /** The event that last woke this entry in this iteration (kept through retry and goto). */
  woke?: { type: string; data: Dict };
  /** The agent ended (or will end) its turn on purpose: `flow wait`. */
  wait?: AgentWait;
}

/** Declared mid-turn it parks on that turn's end; the agent's next turn uses it up. */
export interface AgentWait { note: string; human: boolean; since: number; parked: boolean }

/** queued: started over max_runs; open (it binds sessions), waits for a free slot */
export type RunStatus = "queued" | "running" | "paused" | "needs-human" | "done" | "stopped";
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
  /** when the run started (ms), for {{run.date}} */
  startedAt?: number;
  /** a queued run: the event that triggered it, handed to its start */
  queuedEvent?: FlowEvent;
  /** a queued run: the place in line its sessions were last told */
  queuePos?: number;
  /** the entry whose agent has not started; its first active resumes the run */
  startBlocked?: string;
}

export type SessionStatus = "active" | "completed" | "idle" | "blocked" | "closed";

export type Input =
  | { kind: "start"; event?: FlowEvent; vars?: Record<string, string> }
  | { kind: "report"; entry: string; outcome: Outcome; note?: string; evidence?: string; by: "agent" | "human" | "system" }
  | { kind: "skip"; entry: string; note: string }
  | { kind: "goto"; entry: string }
  | { kind: "retry"; entry: string }
  | { kind: "event"; event: FlowEvent }
  | { kind: "session"; session: string; status: SessionStatus }
  | { kind: "compacted"; session: string }
  | { kind: "tick" }
  | { kind: "hold-free" }
  | { kind: "queued"; position: number; open: number; max: number }
  | { kind: "set"; vars: Record<string, string> }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }
  | { kind: "bind"; role: string; session: string | null; by: "spawn" | "human" }
  | { kind: "respawn"; role: string }
  | { kind: "halt"; reason: string }
  | { kind: "start-blocked"; entry: string; reason: string }
  | { kind: "delivered"; entry: string }
  | { kind: "wait"; entry: string; note: string; human: boolean; sessionActive: boolean };

export type Action =
  | { kind: "deliver"; role: string; text: string; entry?: string }
  | { kind: "watch"; entry: string; waitFor: WaitFor; previous?: { type: string; data: Dict } }
  | { kind: "unwatch"; entry: string }
  | { kind: "plugin-action"; entry: string; name: string; with: Dict }
  | { kind: "shell"; entry: string; command: string; cwd: string; env: Record<string, string>; timeoutMs: number }
  | { kind: "emit"; event: FlowEvent };

export interface StepResult { run: RunState; actions: Action[]; error?: string }
