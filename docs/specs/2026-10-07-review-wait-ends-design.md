# A review wait that cannot end

## Problem

An agent step waits on `gh.review` and re-arms with `flow failed` while approvals are missing. The
user merged the PR by hand: no review ever comes, the step waits forever, and the agent, told
"merged", is refused (`step … is not active (waiting)`). Only "Skip this step" in the UI helps.

## Decisions

- **The PR's end ends the wait (gh plugin).** A `gh.review` wait sees the PR's state on every poll,
  the first included. Merged: emit `done` with `merged: true`; closed: `failed` with
  `merged: false`. With the reviewer options the event carries a review's keys too (`kind`
  `merged`/`closed`, empty `by`/`id`, `url` the PR) so prompts written for reviews still render.
- **The agent may close its own re-armed wait (engine).** An agent's report is accepted on its
  current step while it is `waiting` for its event, if the step reached it before in this
  iteration (`attempts > 0`) and is not queued for a hold. Its turn then can only come from the
  user, as with a failed step. A wait it never had is refused:
  `step X waits for <type> and has not reached you yet` (the double-`flow done` guard).

## Testing

gh: merged/closed end both review paths, on the first poll too. Engine: a re-armed wait closes on
the agent's `done` and unwatches; a fresh one refuses.
