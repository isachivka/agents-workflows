---
name: flow
description: Use when a line starting with "▶ flow:" appears in the session, or when the user mentions flowd, `flow show` or `flow done` — this session is a role in a flows process and must take its current step, do it and report it.
---

# flow

This session is one role in a process that flowd runs. flowd types a line like

    ▶ flow: step task-review · pr-loop#3 it.2 — run `flow show` for the instructions

when a step is yours. Then:

1. Run `flow show`. It prints the step's instructions, the event that woke it (CI result,
   a merge, a signal) and the run's variables.
2. Do the step as written.
3. Report once: `flow done [--note "…"] [--evidence URL]`, or `flow failed --note "what went wrong"`.
   Never report what you did not verify.
4. Values later steps need go into run variables: `flow set pr=<url>`, `flow set worktree=<path>`.
   **The moment your work has a pull request** — you opened it, or found the one it belongs to —
   run `flow set pr=<url>` right away, even if the step does not ask. `pr` is the standard name:
   the UI's "Open the PR" button and the `gh` waits read it. Never invent another name for it.
5. After reporting, end your turn. The next step arrives as a new `▶ flow:` line.

Never end a turn without one of `flow done`, `flow failed` or `flow wait`. When the step has you
wait for something before you can finish it (a job you sent to the background, the user reading
or picking something in a viewer), run `flow wait --note "<what you are waiting for>"` first, and
add `--human` when the user has to act. Then end your turn. When you come back, finish with
`flow done`/`flow failed`, or wait again with a fresh note: each wait covers one turn end. Always
give the note — it is what the user sees. Without `flow wait`, flowd types reminders into your
session and stops the run after the third silent turn end.

## After `flow failed`

Unless the step says otherwise, a failure stops the run for the user: the step stays `failed`,
nothing new arrives, and your session stays open. The user decides, often by talking to you here.
Then:

- **The user tells you to go on** (re-run something, try another way, accept it as is): do what
  they asked, then close the step for them with `flow done --human --note "<what was decided and
  done>"`. The run moves to its next step. If it still fails, `flow failed --human --note "…"`:
  the run stays stopped. Plain `flow done` is refused here (`step X is not active (failed)`):
  only the user can reopen a failed step, so `--human` says the user's decision is behind it.
- **The user wants the whole step again**, from its instructions: they press "Try again" in the
  flows UI; a new `▶ flow:` line arrives.
- **Never use `--human` on your own.** Only after the user, in this session, told you how to go
  on. Say in the note that it was their call.

A refusal (`flow: …`, exit 1) is an answer, not a glitch. `step X has not reached the agent yet`
means you already reported and the next step is on its way — wait for its line.
If `flow show` says no step is active for this session, do nothing and tell the user.
