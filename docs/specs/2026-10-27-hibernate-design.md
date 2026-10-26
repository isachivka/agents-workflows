# Putting a parked run's agent to sleep, and waking it with its conversation

## Problem

A factory process (one run per reel) parks each run for hours on a person's review. With `max_working`
the queue keeps moving, so parked runs pile up, each holding an agterm session with an idle Claude:
dozens to hundreds overnight. Spawns into a crowded agterm have started failing ("session closed" or
"has not started 2 min after its line" right after spawn, with ~14 sessions open).

## Goals

- Opt in per process: an agent whose run stays parked longer than a set time is closed; its
  conversation is kept and resumed when the run needs that role again, with its full context.
- Nothing a person has to do: sleeping and waking happen by themselves; the UI shows who sleeps.

## Non-goals

- zmx processes, roles that are neither Claude nor Codex, and runs that lend or borrow an agent (a nested
  run, or a run with one inside): their roles are never put to sleep.
- Sleeping a role whose agent is in the middle of something (a turn, a plain `flow wait` job).

## Decisions

- **Key.** `hibernate: <duration>` on the process (`30m`, `2h`). Strictly opt-in: only a process that
  declares it in its own definition is ever touched. No default, no global or plugin switch, no
  inheritance (a nested run follows its own process, and nested runs never sleep anyway). A process
  without the key behaves exactly as before: its sessions are never closed by flowd, whatever it waits on.
- **When a role sleeps.** On flowd's tick, for a run of such a process that is parked (as `max_working`
  defines it: a wait, a hold queue, a pause entry, a human step, `flow wait --human`, needs-human) since
  longer than the duration — measured from when its current entry started waiting (`startedAt`, or the
  hold queue's `since`, or the human wait's `since`) — each bound agent role whose session is idle (its
  last status `completed` or `idle`, not `active` or `blocked`) is put to sleep:
  1. find its conversation as "restore session" does (`~/.claude/projects` for Claude, `~/.codex/sessions`
     for Codex, by the run's step lines); none found: the role stays awake (logged);
  2. store `run.asleep[role] = {agent, conversation, cwd}` and unbind the role, in one commit, so the
     session's close is not taken for "role … session closed";
  3. close the session (`agtermctl session close`).
- **Waking.** Nothing new decides when: the outbox already spawns an agent for a line to an unbound
  role. For a sleeping role it spawns `<spawn> --resume <id> <line>` (Codex: `<spawn> resume <id> <line>`)
  in the conversation's cwd, same workspace, window and session name, then clears `asleep[role]`. The
  usual start watch applies (trust dialog, "has not started" timeout). So a review comment that wakes the
  feedback step, a granted screen hold, a `do: type` — anything that sends the role a line — wakes it.
- **Ending.** A run that ends with a sleeping role has nothing to close. `restore session` on a sleeping
  role opens its conversation as it does for any closed one.
- **UI.** A sleeping role shows "спит / asleep" in the run's agents with a Wake button: it sends the role
  the current step's line again if the step is the role's, else opens it as restore does.
- **State.** `asleep` lives in the run (the database), so sleeping and waking survive a flowd restart.

## Testing

daemon (fake agterm, fake transcripts dir): a process without `hibernate`, parked for days with an idle
agent and a conversation on disk, keeps its session and its role bound; a run of a `hibernate: 30m` process parked 31 minutes with an
idle agent has the role unbound, `asleep` set and the session closed, and is not needs-human; an active
agent, a plain `flow wait`, a nested run, a zmx process, and no conversation found keep the role awake;
the next line to the role spawns with `--resume <id>` and the line, and clears `asleep`; a run ending
with a sleeping role closes nothing. defs: `hibernate` takes a duration; a bad one is an error.
