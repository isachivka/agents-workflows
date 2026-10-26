# Capping the runs that work, not the ones that wait

## Problem

`max_runs` counts every open run. A factory process (one run per reel, each waiting days for the
person's review) fills its limit with runs that only wait, and the hundreds queued behind them never
start until the person reviews. The cap is still needed: it is how many agents write at once.

## Decisions

- A process key `max_working: N`: the runs counted are the open ones that are not parked. Parked: the
  run is not `running` (paused, needs-human), or its current entry is a human step, an `inner` (the
  nested run counts for its own process), `waiting` (a pure wait, an agent step its `wait_for` has not
  woken, a pause entry, queued for a hold), or an agent's `flow wait --human`. An agent's plain
  `flow wait` counts: its background job is work.
- The queue is checked after every change, as now: a run that parks lets the oldest queued one start.
  A parked run that wakes goes on even when that puts the process over `max_working` (it cannot be
  held back mid-run); new starts wait until the count is under the limit again.
- Alone, `max_working` leaves open runs uncapped (`max_runs` defaults to none instead of 1). With both,
  both apply. `max_runs` alone keeps its meaning: processes that cap open runs for the person's sake
  (reviews) are unchanged.
- The queue's numbers (`queued: {position, open, max}`) are the working count and `max_working` for such
  a process. A cron start over the limit is skipped, as with `max_runs`.

## Testing

daemon: with `max_working: 2`, four starts run two and queue two; one parking on a wait starts the
third; a woken run goes on over the limit and the fourth stays queued; a cron start over it is skipped.
defs: alone it lifts the `max_runs` default; both parse; a bad value is an error.
