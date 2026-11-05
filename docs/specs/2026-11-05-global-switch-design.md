# One switch for everything: flows off and on

## Problem

Stopping everything at once (an incident, an agent doing harm, the machine needed for something else) means
pausing runs one by one in the UI while schedules and triggers keep starting new ones. `pause_on` does the
right thing, but only per process and only when a plugin flips it.

## Goals

- One switch, in the UI header on every page, that turns flowd **off** and back **on**.
- **Off:** every running run pauses, marked as the switch's (`pausedBy: "off"`); an agent mid-turn gets Esc
  (ends the turn and what it runs) and a line to stop, put back what it changed and end its turn. Nothing new
  starts.
- **While off:**
  - a schedule (cron) that comes due is skipped, said as `flow.trigger.skipped`, never run later;
  - a start by an event trigger (a PR opened, CI on main) or by hand queues, and starts when flowd is on;
  - an event for a run (CI green, an approval, a merge, a `flow signal`) is kept and acted on when flowd is
    on. Nothing moves while off: no step advances, no line is typed, no command runs.
- **On:** the runs the switch paused go on; an agent stopped mid-step gets `▶ flow: <run> goes on: flows is
  on again. Carry on with step <id> from where you stopped`. The kept events are acted on, the queue moves.
  Runs paused by the person, or by a process's `pause_on`, stay as they are.
- The state survives a flowd restart; after a restart while off, an agent that starts a turn in a run the
  switch paused is stopped too (as `pause_on` does).

## Non-goals

- One switch across several flowd hosts: each flowd has its own, in its own UI.
- Killing an `sh` command that is already running: it finishes, and its result is acted on when flowd is
  on (my call: a killed command is retried, and not every command is safe to retry).
- Putting agents to sleep: unlike `pause_on`, off does not hibernate idle agents; their sessions stay as
  they are (my call: an emergency stop should not close the windows the person is looking at).

## Design

- **State.** A `settings` table in the store (key/value); key `off` holds when it was turned off. `Flowd`
  reads it at start.
- **Off** reuses `pauseProcess`'s machinery for all processes: `pause` with `by: "off"` for every running
  run, `stopAgent` for sessions that are `active` or `blocked`, with the stop line naming the switch.
- **Starts.** `startRun` treats every process as paused by a switch while off: cron is skipped, the rest
  queue (the queue already holds a trigger's event for the first step).
- **Events.** While off, `process()` leaves an event that names a run, or that a plugin watch emitted for
  one, unprocessed; turning on processes `unprocessed()` in order, as a restart does. Events that only
  start runs go through `startRun` and queue as above. `run.*` and `entry.*` commands from the UI or CLI
  (skip, retry, stop, set) still work while off: the person is in charge.
- **Ticks.** While off, ticks do not time out, remind, or end delays of switch-paused runs (paused time
  does not count, as today); the outbox holds their lines (paused runs are held; a person's message still
  goes through, as fixed today).
- **On** mirrors `resumeProcess`: resume the runs `pausedBy: "off"`, queue the carry-on line, process the
  kept events, `startQueued()`, flush.
- **API.** `GET /api/state` (or the existing state the UI polls) carries `off: <ms>|null`;
  `POST /api/off` and `POST /api/on`. CLI `flow off` / `flow on`, so an agent or a phone shell can flip it.
- **UI.** A switch in the header: green "ON"; turning it off asks for confirmation. While off, a red bar
  under the header: "flows is off since 14:02: nothing new starts, runs are paused" and a Turn on button.
  The runs it paused show "paused: flows is off".

## Testing

- Off pauses running runs, sends Esc and the stop line to an active agent, leaves an idle one alone.
- While off: cron skipped (and `flow.trigger.skipped` emitted), an event trigger queues, a manual start
  queues; a `gh.checks` event for a waiting run is not acted on.
- On: the switch's runs resume, the stopped agent gets the carry-on line, the kept event moves the run,
  the queued runs start, the skipped cron does not; a run the person paused stays paused.
- Off survives a restart.
- UI: the header switch and the bar (`test/ui*.test.ts` style), the HTTP endpoints.
