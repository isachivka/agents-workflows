# Hibernate never closes an agent that waits for the person

Amends [2026-10-27-hibernate-design.md](2026-10-27-hibernate-design.md).

## Problem

Hibernate counts `flow wait --human` and a run that needs the person as parked, and puts their idle
agents to sleep like any other. On a review wait with `hibernate: 0s`, a reel's maker was asked by the
person to explain something in its terminal; it answered with two questions, ran
`flow wait --human`, and flowd closed its session at once, in front of the person, before they had read
the answer. The same happens to a run that stops for the person (`needs-human`): the usual way back is
to talk to the agent in its terminal, and that terminal is gone. An agent that waits for the person is
the conversation the person is in.

## Decisions

- A role is never put to sleep while the run waits for the person through it:
  - its current agent step is in `flow wait --human`;
  - or the run is `needs-human` (a failed step, the silent-turn rule, a start that never came), whatever
    entry it stands on.
  Its session stays open as without `hibernate`. Once the person answers and the agent goes on, the
  rules are the usual ones again (the next park, for that entry's or the process's time).
- This holds over a `pause_on` pause too: a paused run's agent waiting for the person stays awake (it
  is idle anyway; the pause stops work, not a conversation).
- Unchanged: an event wait (a review on the site, CI), a hold queue, a pause entry, a human entry
  (`role: human`: the person acts in the UI, not in an agent's terminal), a plain `flow wait`. Their idle
  agents sleep as before. `max_working` still counts `flow wait --human` and `needs-human` as parked.

## Testing

daemon (fake agterm, fake transcripts dir): a `hibernate: 0s` entry whose agent runs `flow wait --human`
and ends its turn keeps its session at the next ticks, and sleeps after the person's answer leads to a
later park; a `needs-human` run of a `hibernate` process keeps its idle agent; a run paused by its switch
keeps an agent in `flow wait --human` and sleeps one that is not; an event wait still sleeps at once.
Docs: `hibernate` in docs/processes.md and skills/flow-author.
