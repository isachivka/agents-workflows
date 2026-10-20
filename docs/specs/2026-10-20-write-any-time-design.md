# Writing to the run's agent at any time; the PR in "waits for you"

Amends [2026-10-18-run-chat-design.md](2026-10-18-run-chat-design.md) (incoming messages) and
[2026-10-19-notify-design.md](2026-10-19-notify-design.md) (the default waits text).

## Problem

A run waiting at a human step ("approved and green, waits to be merged") answered every message with
`no agent is on a step now … write again when one is`: the person on a phone could not ask the agent
for the PR link, and the notice itself did not carry it.

## Decisions

- A message goes to the agent of the current step when there is one, as before. Otherwise (a human
  step, a wait, an `sh`, a paused or needs-human run) to the role whose agent step started last in this
  iteration and whose session is bound, else to any role with a bound session. The typed text adds:
  `The run is at <entry>, not a step of yours: answer, and do not run flow done or flow failed for it.`
- Only a run with no bound agent (queued, nothing spawned yet) answers
  `<run> has no agent yet: it is <status|at entry>. Write again once one has started`.
- The default waits text gets `vars.pr` on its own line when set. Custom texts are unchanged.

## Testing

daemon-chat: at a human step the last agent gets the message with the line; before any agent step the
bound agent gets it; a queued run and an ended run answer; the waits notice carries the PR.
