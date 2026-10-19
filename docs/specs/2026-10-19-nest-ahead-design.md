# Choosing the nested process before the run reaches inner

Amends [2026-10-15-nested-runs-design.md](2026-10-15-nested-runs-design.md), "Choosing the inner process".

## Problem

A start on a busy agent is accepted only while the run on top stands on its `inner` entry. A person
who starts an issue-tracker run and, seconds later, the PR process that should run inside it gets
`… is busy with tracker#3 at step find; a nested process can start when it reaches inner`, and has to
come back when the run gets there.

## Decision

A start on a busy agent whose run has not reached its `inner` yet is taken as the choice for it, as
`--inner` at that run's start would have been:

- Accepted when the run on top of the session is open, has an `inner` entry for the role bound to
  that session still ahead in this iteration (pending), nothing is chosen for it (`run.inner` empty),
  and the chain `[process, ...--inner]` is valid from that run's process.
- The run's `inner` becomes that chain; nothing starts now. When the run reaches `inner`, the nested
  run starts as for `--inner` (the parent's vars, the lent agent).
- The answer is the run's id with `nests: {process, in: <run>}`; `flow start` prints
  `<process> will run inside <run> when it reaches inner`.
- Refused, saying why: something is already chosen (`<run> already runs <process> inside; …`), the
  start has `--var` (they could not be kept: start it when the run reaches inner), or no inner is
  ahead (the old `is busy` text).

## Testing

`test/daemon-nested.test.ts`: a start at the step before inner is accepted, sets the chain, and the
nested run starts when inner is reached; a second start is refused; `--var` is refused; a process
past its inner, or without one, is refused as before; `flow start` prints the line.
