# Reopening an ended run at an entry, its agents resuming their conversations

## Problem

A person approves a reel (the run goes feedback → done, the maker closes its terminal), then changes
their mind: the reel should go back to review and the same maker, with its whole conversation, should
redo it from a new comment. Nothing can bring an ended run back: the engine refuses every input on a
`done`, `failed` or `stopped` run, and "restore session" only reopens the conversation in a terminal
the run no longer drives (and focuses it, taking the person's agterm). The reels site wants to do this
from a "Back to review" button, through an `sh` step.

## Goals

- One call puts an ended run back to work at a chosen entry, with its vars and iteration.
- Its agents come back as hibernate brings them back: asleep, woken into their own conversation by the
  next line the run sends them. Nothing is spawned or focused by the reopen itself.

## Non-goals

- Reopening a nested run (its parent decided what its end meant), or an open run (that is `goto`).
- A UI button for it (the API and the CLI first; a button can follow).

## Decisions

- **Surfaces.** `POST /api/runs/:id/reopen {entry, note?}` and `flow reopen <run> --at <entry> [--note …]`.
  `goto` on an ended run keeps refusing and says to use reopen: a goto never brings a run back by
  accident (a stale UI page, a script with the wrong id).
- **Refused** when the run is open, nested, its process is missing or invalid, or the entry is not in it.
- **The engine** gets an input `reopen {entry, asleep}`: the run becomes `running` (reason cleared),
  vars and iteration kept, and enters `entry` as a goto does (that entry and the ones after it start
  over; attempts, failures and what last woke a wait are kept, so a wait on reels.review does not fire
  again on the review that ended the run). It emits `flow.run.reopened {entry, note}`; ending again
  emits `flow.run.done` again.
- **Its agents.** Before submitting, flowd looks at each agent role of the run (Claude or Codex, agterm):
  - its session is still open in agterm: it stays bound (and is no longer closed as "an ended run's idle
    agent" by hibernate);
  - otherwise its conversation is found as hibernate and restore find it (`asleep`, else
    `~/.claude/projects` / `~/.codex/sessions` by the run's step lines) and the role is put asleep with it;
  - none found: the role is unbound, and the next line spawns a fresh agent, as for any unbound role
    (logged).
  The usual wake applies: the line the reopened entry sends (at once for an agent step, when its event
  arrives for one with `wait_for`) spawns `--resume <id>` with it, in the conversation's cwd.
- **Limits.** A reopen is a person's act on one run: it is not queued by `max_runs`; `max_working`
  counts it only while it works. Holds and a `pause_on` switch apply to it as to any running run.
- **Its conversation in the messenger.** The run's closed conversation is used again: an adapter's optional
  `reopen(address)` is called (Telegram: `reopenForumTopic`). `notify: false` stays silent as before.

## Testing

engine: reopen on a done/failed/stopped run runs from the entry with vars and iteration kept, resets that
entry onward, keeps a wait's last wake, emits `flow.run.reopened`; refused on an open or nested run and an
unknown entry. daemon (fake agterm, fake transcripts dir): a reopened run's role with a closed session and
a conversation on disk is asleep, nothing is spawned or focused, and the wait's event spawns `--resume`
with the line; a role whose session is open stays bound and is not closed afterwards; no conversation:
unbound, the next line spawns fresh; Telegram fake: `reopen` is called. http/cli: the verb and its refusals;
`goto` on an ended run points to reopen.
