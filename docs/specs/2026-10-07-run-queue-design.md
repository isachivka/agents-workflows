# A start over max_runs waits in line

## Problem

A process at `max_runs` refuses `flow start`, and an event trigger at the limit is skipped. The
limit is deliberate (people review what the runs produce, so a few at a time), but a refusal
leaves the work with nobody: an agent handing its branch over must remember to retry, and a
skipped trigger is lost.

## Goals

- A manual start or an event trigger over the limit creates the run as `queued`: it has its id,
  vars and bound sessions, and no entry starts.
- When an open run of the process finishes or is stopped (or `max_runs` is raised), the run that
  queued first starts, exactly as a fresh start would, with the event that triggered it.
- A queued run's bound sessions are told their place when it changes:
  `▶ flow: <run> is queued — now 1st in line (5 of 5 runs open). Nothing to do: it starts by itself.`
- `flow start` over the limit succeeds and says so: `<run> queued: 2nd in line, 5 of 5 runs open`.
- UI and `flow ls` show the place. Stop cancels a queued run.

## Non-goals

- Cron triggers keep skipping (`flow.trigger.skipped`): a schedule fires again; a backlog of daily
  runs is not wanted.
- Priorities, or a global limit across processes.

## Decisions

- **Status `queued`**: open (it binds sessions, `flow` finds it), not counted against `max_runs`.
  Run state keeps the start event (`queuedEvent`) and the last told place (`queuePos`).
- **Engine**: `start` on a queued run sets it running and proceeds; a new input
  `{kind: "queued", position, open, max}` records the place and types the notice to every bound
  role (never spawns one).
- **Daemon**: after every applied input, at start and after a definitions reload, for each process
  it starts queued runs (oldest first) while fewer than `max_runs` are open, then sends the new
  place to the rest whose place changed.
- **Refusals**: a step command from a queued run's session says
  `<run> is queued (2nd in line); its first step comes when a run of <process> ends`.

## Testing

Daemon: over the limit queues with vars and binding; the holder's stop starts it and its session
gets the first step; a third run is told its new place; a cron start over the limit is still
skipped. CLI: the queued line. Engine: start from queued, the notice goes to bound roles only.
