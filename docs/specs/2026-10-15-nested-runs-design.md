# Nested runs: several processes driving one agent

## Problem

A person wants one agent driven by more than one process at once, composed on the fly rather than
written as one big process. Example: an issue-tracker process finds or creates the issue, then
whatever process does the work (open a PR, get it merged) runs in the same agent, then the
tracker process moves the issue on, knowing the PR. Today a session belongs to one open run:
`flow start … --bind dev=<session>` on a busy session is refused (`already bound`), because a turn
end, `flow done/set/wait` and reminders are routed session → run. Reusable steps already exist,
but putting them together means a process per combination (PR + tracker, other PR + tracker, …).

## Goals

- A process marks the place where another process runs in the same agent: one entry, `inner`.
- Which process runs there is chosen at start (`--inner`), later (a start on that agent while it
  waits), or not at all (skip).
- Any depth: wrappers wrap wrappers.
- Processes that do not use it do not change.

## Non-goals

- Interrupting a run at an arbitrary step. A start on a busy agent is accepted only when the run
  on top stands on `inner`.
- Two processes giving one agent steps at the same time.
- `include:` of one process's steps into another at definition time.
- `repeat: true` processes as inner (they never finish).

## Decisions

### The entry

`{inner: true, role: <role>}` — a new entry kind. `role` names the agent that is lent to the
inner run. It takes `timeout` and `on_fail` like any entry; no `timeout` means it waits without a
limit, like a human step. No reminders: it waits for the person, not the agent.

```yaml
steps:
  - {step: tracker-find, role: dev}         # flow set issue=KEY
  - {inner: true, role: dev}
  - {step: tracker-transition, role: dev}   # uses {{vars.issue}} and {{vars.pr}}
```

### A stack of runs on a session

- A run started by `inner` (the child) records its parent: `RunState.parent = {run, entry}`; the
  parent's entry state records `child`. Both live in the run's JSON state: no schema change.
- The lent session is bound in both runs. `store.runBySession` — the one place every session →
  run lookup goes through (turn ends and statuses, `flow done/set/wait`, ping, the hook) —
  returns the top: the open run bound to the session that has no open child bound to it.
- While its child is open the parent stands on `inner` with status `waiting`; nothing is typed
  to the agent for it.

### Choosing the inner process

- `flow start A --inner B --inner C --bind dev=S`: left to right, outer to inner. A's `inner`
  starts B, B's `inner` starts C. The chain is checked at start: a process in it that has no
  `inner` entry with more names after it is refused (`B has no inner step, so C has nowhere to
  go`), as is an unknown or `repeat` process. A shorter chain is fine: the last `inner` waits.
- `--inner none` skips that `inner` when the run reaches it (note: `no inner process`).
- Without `--inner`, a run reaching `inner` waits. `flow start B --bind dev=S` on that agent is
  accepted when the top run on S stands on `inner` whose role is bound to S; B becomes its
  child. Any other start on a busy session is refused as today, with what it is waiting on:
  `dev is busy with A#4 at step tracker-find; a nested process can start when it reaches inner`.
- The child's role taking the lent session: the one named like the `inner` entry's role, else the
  child's only role; otherwise the start is refused, naming the roles. The child's other roles
  spawn their own sessions as usual.
- A child over its `max_runs` queues as any run; the parent keeps waiting.

### Variables

- The child starts with a copy of the parent's vars (`--var` on top).
- When the child ends done, the vars it set (new, or changed from the copy) are copied into the
  parent: the tracker step reads the `pr` the PR process found.

### Ends

- Child done → the parent's `inner` is done (note: `<child id> done`), the parent goes on.
- Child stopped or ended failed → the parent's `inner` fails with the child's reason; its
  `on_fail` decides.
- Parent stopped → its open child is stopped too. Pause does not cascade.
- The child's end reaches the parent as an input from the daemon; a restart in between is
  reconciled on start (a parent on `inner` whose child is closed).
- `do: clear` on the lent role in a child is refused at the child's start (it would wipe the
  parent's context); `compact` is allowed.

### Skip

The engine's `skip` works on `inner` as on any step. New: `flow skip [<run>] --note "…"` in the
CLI (today only the UI and HTTP have it), and the waiting `inner` in the UI gets Skip with the
reason filled in.

### UI — after the engine, with the designer

Nesting is hard to show. The engine stage ships CLI and HTTP only. The UI (a child under its
parent, "A#4 waits for B#12", Start nested… / Skip on a waiting `inner`) is designed first in a
session with the designer on the flows design canvas, then gets its own plan.

## Testing

Engine: `inner` waits, starts a child from the chain, `none` skips, child done/failed/stopped,
vars down and back, timeout. Daemon: `runBySession` returns the top, a start on a busy session
accepted only on `inner`, the refusal text, role matching, chain checks, stop cascades, restart
reconciliation, `clear` refused. Defs and `flow check`: `inner` keys. CLI: `--inner`, `flow skip`.
By hand: a two-level demo with harmless steps, after the user says yes.
