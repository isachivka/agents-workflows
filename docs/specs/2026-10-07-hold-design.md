# A named hold on entries — one desk, several runs

## Problem

A process that deploys to a shared test environment and runs autotests there can only have one
run inside that stretch at a time. Today the only tool is `max_runs: 1`, which blocks the whole
process: a second run cannot even open its PR while the first one sits in review for a day, long
after it left the shared environment.

## Goals

- Mark the entries that use a shared thing: `hold: <name>`. One open run at a time may stand on
  an entry holding a given name; the others queue in front of it.
- The holder keeps the name across consecutive holding entries (deploy, then autotests) and while
  such an entry failed and waits for a person: the environment still carries its build.
- Leaving the holding entries, finishing or stopping the run frees the name. The run that has
  queued longest takes it.
- A queued run says what it waits for and who holds it: UI, `flow ls`.
- The name is global: entries of different processes holding the same name share one queue.

## Non-goals

- Counting semaphores (two slots). One holder per name.
- Holds that span non-consecutive entries, or explicit acquire/release entries.
- Priorities.

## Decisions

- **Engine.** `StepCtx` gains `holders: Record<name, runId>` from the daemon. Entering an entry
  whose `hold` another run holds sets it `waiting` with `queued: {hold, since}` and does nothing
  else: no watch, no delivery, no pause timer. A new input `hold-free` lets it proceed exactly as
  entering would have, with `startedAt` reset so its `timeout` counts from then. A tick ignores a
  queued entry (no timeout while queued).
- **Who holds.** An open run whose current entry has `hold: H` and is not queued — whatever its
  status (active, waiting, failed, paused).
- **Daemon.** After every applied input, after a definitions reload and at start, it hands each
  free name to the running run that queued for it first.
- **Validation.** `hold` is a name: lowercase letters, digits, dashes. Allowed on any entry.
- **Summary.** `RunSummary.heldBy: {hold, run} | null` for a queued run; the UI shows "Waits for
  desk-1: pr-loop#3 has it" as a waiting state, `flow ls` shows `waits hold desk-1 (pr-loop#3)`.

## Testing

Engine: queue when held by another run, proceed on `hold-free`, keep the hold across two holding
entries, no timeout while queued. Daemon: a second run queues and starts when the first moves on;
stopping the holder frees it; first queued is served first. Defs: valid and invalid names.
