# Agents that wait on purpose: `flow wait`

Status: implemented 2026-10-07 (main `3b572b0`). The implementation corrected parts of this design;
those places are marked *(amended: A1–A2)* and explained in [Amendments](#amendments). The current
behaviour is documented in `docs/concepts.md` and `docs/cli.md`.

## Problem

flowd treats an agent that ends its turn without `flow done` or `flow failed` as having
forgotten to report (`src/engine.ts`, the `session` and `tick` inputs): 30 s after every
`active` → `completed`/`idle` it types a reminder, and the third such turn end halts the run with
"the agent ended its turn N times without flow done/failed". `reminded` only resets when the
entry is entered again or recovered.

Some steps end the agent's turn on purpose and legitimately stay open across several turns:

- a review that runs 15+ minutes in the background and then waits for the user to pick findings
  in a viewer (the agent's skill tells it to wait for the background notification);
- the user reading a PR in a viewer: the launcher blocks, the agent's shell tool gives up after
  10 minutes, and the agent ends its turn to wait for the user;
- a long test run or build sent to the background.

Today each of those halts the run, and reminder lines are typed into the session while the user
is in an overlay. A real process (one agent driving a whole migration wave from pick to merge)
cannot start until this is fixed.

## Goals

1. An agent can declare "I am ending my turn on purpose, waiting for X" — `flow wait --note "X"`
   — and no reminder or halt follows from that turn end.
2. The declaration is narrow: it covers one wait. When the agent's next turn begins, it is used
   up; a later forgotten report is reminded as today.
3. The user sees which steps are waiting on an agent, for what, and since when; a wait on the
   user puts the run under "Needs you".
4. An agent that forgot learns about `flow wait` from the first reminder.

## Non-goals

A deadline on the wait itself (the entry's `timeout` already bounds a step); flowd waking the
agent when the background work ends (the agent's own tool does that); changing how many
reminders a forgetful agent gets.

## Design

### The command

```
flow wait --note "<what I am waiting for>" [--human]
flow wait --note "…" --run ID --step ID            (from a terminal, like done/failed)
```

- `--note` is required (`flow wait needs --note saying what you are waiting for`), like `flow failed`.
- `--human` says the wait is on a person (the user picks findings, reads a PR). It only changes
  what the UI shows (below).
- Target resolution and agent guards are the ones `flow done` uses: the session's open run, its
  current entry, of the caller's role; an agent step (`kind: agent`), `active`, and delivered
  (`step X has not reached the agent yet`). Any other entry kind is refused:
  `flow wait is for an agent's step; <id> is a <kind> step`.
- It may be called any number of times; the last call wins (new note, new time).
- HTTP: `POST /api/wait {session? | run+entry, note, human?}` → event `entry.wait`
  (`data: {session?, run?, entry?, note, human}`), handled like `entry.report`.

### State and the turn rule

`EntryState` gains `wait?: { note: string; human: boolean; since: number; parked: boolean }`.

A wait is declared mid-turn, while the session is `active`, and is meant for the turn end that
follows. agterm reports status changes, and flowd re-submits the stored status on resync, so the
same status can arrive twice. The rule is therefore phased:

| Wait state | Session goes `active` | Session goes `completed`/`idle` |
|---|---|---|
| none | as today (`sawActive`, cancel `remindAt`) | as today (`remindAt = now + 30 s` after `sawActive`) |
| declared (`parked: false`) — same turn | stays declared (a repeat `active` in the same turn) | becomes `parked: true`; no `remindAt` |
| parked (`parked: true`) — between turns | **the next turn has begun: the wait is used up** (`wait` cleared), then as today | stays parked (a repeated idle); no `remindAt` |

On `flow wait`:
- `reminded` is reset to 0 and any pending `remindAt` cleared — the agent answered.
- The daemon passes the session's last known status with the input. If it is not `active` (the
  call came after the turn ended, or from a terminal with `--run/--step`), the wait starts out
  `parked`: no idle transition will follow to park it. *(amended: A1 — the agent's session status
  decides, not who sent the call; `blocked` and an unknown status count as mid-turn.)*

`flow done`/`flow failed` end the entry, so the wait goes with it; entering an entry (advance,
retry, goto, a new iteration) starts without a wait.

Unchanged on purpose:
- The entry's `timeout` keeps running while the agent waits and fails the step as today.
- A turn that agterm never sees (no `active` status change) does not use up the wait.
- A run that is already `needs-human` is not resumed by `flow wait`; the user decides.

### Reminder text

```
▶ flow: step <id> is not closed — `flow done`, `flow failed --note "…"`, or `flow wait --note "…"` if you are waiting on purpose
```

### What the user sees

- `RunSummary` gains `agentWait: { note: string; human: boolean; since: number } | null` for the
  current entry.
- Runs list: the current entry reads `active · waiting: <note>`. A `--human` wait makes
  `needsYou` true, so the run is listed under "Needs you".
- Run page: the entry panel shows `waiting since <time>: <note>`; the strip marks the entry with ⏸.
- `flow ls`: `<entry> (active, waiting: <note>)`.
- `flow show` prints `waiting since <time>: <note>` under the header when a wait is set, so an
  agent coming back to the step sees what it was waiting for.
- The run's event log shows each `entry.wait` with its note (it is a stored event).

## Testing

Engine (`test/engine-runtime.test.ts`): a wait declared while active is not consumed by a repeated
`active` and parks on the next idle with no reminder; a repeated idle while parked sends nothing;
the next `active` uses it up and a later idle is reminded; `reminded` resets on a wait; a wait
from an idle session starts parked; a third legitimate wait in one step does not halt; the
timeout still fails a waiting entry; done/failed/goto/retry clear the wait; refusals for a
non-agent step, an inactive step, an undelivered step, a missing note.
Daemon: `entry.wait` resolves by session like a report and passes the session's status; `flow wait`
from a terminal with `--run/--step` parks at once *(amended: A1 — only once the agent's turn has
ended)*. HTTP and CLI: `/api/wait`, `flow wait` exit
codes and messages, `--human` → `needsYou`. Reminder text includes `flow wait`.
Docs: `concepts.md` (Reminders and timeouts), `cli.md`, `http-api.md`, `skills/flow/SKILL.md`
(when an agent should use it, and to always give the note), `skills/flow-author/SKILL.md` (step
prompts that make the agent wait should tell it to run `flow wait`), `troubleshooting.md`
(a run that stopped for missed reports); `test/docs.test.ts` stays green.
Manual: a throwaway flowd and one live agent session (with the user's yes): a step that tells the
agent to `flow wait`, end its turn, then be woken by the user; no reminder appears; a later
forgotten report is reminded. This also settles whether a turn started by a background-task
notification shows as `active` in agterm.

## Amendments

Found in the final review and the live check; in `main` as of `3b572b0`. Code and the living docs
follow these, not the text above.

**A1. The agent's session status decides whether a new wait parks at once.** As designed, a wait
parked at once unless the call came from the agent's own session with status exactly `active`.
A wait sent while the session was `blocked` (the `flow wait` call itself hit a permission
prompt), while its status was still unknown, or from the user's terminal during the agent's
turn therefore parked early; the turn's late `active` then used it up and the turn end was
reminded — the very thing the feature prevents. Now the status of the session bound to the
step's role decides, whoever sends the call: `active` or `blocked` means a turn end is coming, so
the wait parks then; `completed`/`idle` parks it at once; an unknown status counts as mid-turn
when the call comes from the agent's own session.

**A2. `flow show` names `flow wait`** in its "Report:" line, so an agent reading its step learns
the command before any reminder (goal 4).

The live check (one real Claude session, statuses bridged to a throwaway flowd) confirmed that a
parked wait suppresses the reminder and that the next turn uses it up. Whether a turn started by a
background-task notification shows as `active` in agterm is still unverified; if it does not,
that turn leaves the wait in place and the next turn agterm sees uses it up.

