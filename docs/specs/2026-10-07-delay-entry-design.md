# A pause entry: `wait: <duration>`

Status: approved 2026-10-07 by the user.

## Problem

A process sometimes has to let time pass: keep a reviewer's session for a day after the merge in
case a late finding comes in, then clean up. The only way today is a trick — a pure wait on a
signal nobody sends, with `timeout: 24h` and `on_fail: {goto: …}` — which reads as a failure in
the run's history.

## Decision

A new entry form, on its own (no `step`, `do`, `wait_for`):

```yaml
- {id: tail, wait: 24h}        # 30s, 10m, 2h, 1d
- {step: reap, role: reviewer}
```

- Entering it, the engine marks it `waiting` and records the time (`startedAt`, already kept in
  the run's state for timeouts). A tick at or after `startedAt + wait` closes it `done` (note
  `waited <duration>`) and the run moves on. The clock lives in the database, so a flowd restart
  does not reset the pause.
- The human can end it early (`done`, `skip`) or restart it (`retry`). A paused run's pause
  still elapses; the step closes on the first tick after the run resumes.
- Default id: `wait` (two pauses in a process need explicit ids). Validation: a duration
  `flow check` understands; `wait` with `step`, `do` or `wait_for` is refused.
- Summaries carry `waitUntil` (ms) for a run whose current entry is a pause, and plan entries carry
  `waitMs`; the UI reads "Pause until <time>" and lists the step as "Pause <duration>".

## Testing

defs: parsing, the default id, exclusivity, a bad duration. Engine: entering arms no watch; before
the time nothing happens; at the time it is done and the next entry starts; a human `done` ends it
early; `retry` restarts the clock; a run that resumes late closes it on its first tick. Daemon:
`waitUntil` in the summary. Docs: `processes.md` (entry key and kind, a recipe), `concepts.md`,
`flow-author` skill.
