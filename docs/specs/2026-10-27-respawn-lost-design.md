# Starting a lost agent again, once

## Problem

In a factory process, a freshly spawned agent's session is sometimes closed by something else within
its first minute (a window torn down around it, a close aimed elsewhere). The run stops with
`role … session closed`, and a person has to respawn and retry, though nothing about the step failed.

## Decision

An opt-in process key `respawn_lost: true`. When the session of the role on the current agent step
closes within 10 minutes of the step's line being delivered, before the agent reported or ran
`flow wait`, flowd starts the role again (as the UI's respawn does: a new agent, told to take its step)
instead of stopping the run. Once per step: a second loss in the same step stops the run as before, and
entering the step again (retry, goto, a new iteration) resets it. A process without the key is unchanged.

## Testing

daemon: with the key, an early close spawns again and the run stays running; a second close stops it;
without the key, or 11 minutes in, it stops as before. defs: the key takes true or false.
