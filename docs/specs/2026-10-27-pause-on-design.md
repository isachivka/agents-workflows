# Pausing a process's runs on an outside switch

## Problem

The reels factory may use the screen only while the person allows it (a switch on the reels site). The
switch is checked when a recording step starts; turned off later, agents keep recording and working. The
person wants every reels-make agent to stop at once when it goes off, to sleep while it is off, and to
go on by itself when it comes back on. reels-refine (text only) keeps working.

## Decisions

- **Key.** `pause_on: {on: <event type>, with?: {...}, where: {...}}` on a process. Opt-in: a process
  without it never pauses this way. flowd holds a standing subscription for it, as for an `on:` trigger.
  An event of that type from it that matches `where` pauses the process; one that does not, resumes it.
  For reels: `pause_on: {on: reels.switch, where: {allowed: false}}`.
- **The reels plugin** gets `reels.switch`, a subscription only: it emits `{allowed}` at its first poll
  (so a restarted flowd learns the state) and on every change (30 s polls, as the plugin's other watches).
- **Pausing a process.** flowd marks it paused (in memory; the plugin's first emit restores it) and, for
  each of its open runs that is `running`:
  - the run becomes `paused`, marked `pausedBy: "pause_on"` so a resume never lifts a pause the person set;
  - an agent in the middle of a turn on it (session `active` or `blocked`) gets Esc (Claude and Codex
    stop the turn and what it runs: the recorder dies with it), then, typed at once, bypassing the held
    outbox: `▶ flow: <run> is paused: <process>'s switch is off. Stop now: put back anything you changed
    in the person's setup, then end your turn. flowd tells you when to go on.`;
  - its idle agents are put to sleep at the next tick, as `hibernate` does, whatever the process's
    `hibernate` (a paused run counts as parked with no delay).
  While paused, starts of the process queue (a cron start is skipped), queued runs do not start, and a
  paused run's lines wait in the outbox (as for any paused run): an event that wakes a paused run's wait
  (a review comment) is kept and its line goes out on resume.
- **Resuming.** flowd clears the mark and resumes each run it paused. A run whose current entry is an
  agent step that was under way gets `▶ flow: <run> goes on: the switch is on again. Carry on with step
  <id> from where you stopped (flow show has the instructions).` through the outbox — a sleeping agent
  wakes into its conversation with it. Queued runs start again.
- **Time paused does not count.** A run's pause (any pause, by the person too) shifts its current entry's
  clocks — `startedAt` (timeouts, hibernate), the start watch and reminders — by the time it was paused,
  so a long pause never times a step out on resume. A pause entry (`wait: 24h`) is wall time and is
  not shifted.

## Testing

daemon (fake plugin emitting the switch): an off event pauses running runs of the process with the mark,
presses Esc and types the stop line to an active agent, leaves another process alone, queues a new start,
and sleeps an idle agent at the next tick; an on event resumes only the runs it paused, sends the go-on
line to the role whose step was under way, and starts queued runs; a run paused by the person stays
paused; a process without `pause_on` never pauses; a paused step does not time out on resume. defs:
`pause_on` needs `on`; a bad shape is an error. plugin: `reels.switch` emits at the first poll and on change.
