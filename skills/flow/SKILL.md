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
   **The moment the work has a Slack thread** — someone opened one about it, or a step asks you to
   post there — `flow set slack_thread=<url>`, so the UI can link it.
   Once there is a PR, flowd keeps `title` (what the run is about) in sync with the PR's title by
   itself. Before that, if the run has no `title` yet (`flow show` lists the vars), set a short
   one for the task: `flow set title="Fix the login timeout"`.
5. After reporting, end your turn. The next step arrives as a new `▶ flow:` line.

Never end a turn without one of `flow done`, `flow failed` or `flow wait`. When the step has you
wait for something before you can finish it (a job you sent to the background, the user reading
or picking something in a viewer), run `flow wait --note "<what you are waiting for>"` first, and
add `--human` when the user has to act. Then end your turn. When you come back, finish with
`flow done`/`flow failed`, or wait again with a fresh note: each wait covers one turn end. Always
give the note — it is what the user sees. Without `flow wait`, flowd types reminders into your
session and stops the run after the third silent turn end.

## After `flow failed`

A failure usually stops the run for the user: nothing new arrives and your session stays open.
The step is still yours. When the user then talks to you about it — a hint, a different
approach, "do it this way" — that is their decision. Do the work, and **once the step's goal is
reached, verified as for any step, report it as usual: `flow done --note "…"`**. The run goes
on to its next step. Do not ask the user to confirm closing it, and do not wait for them to press
anything; say in the note what changed after the failure. If it still does not work,
`flow failed --note "…"` again and the run stays stopped.

The same goes for a step of yours that waits for an event again (a review wait after your
`flow failed --note "waiting: …"`): if the user tells you it is moot — they merged the PR by hand,
the reviewer is away — `flow done --note "…"` ends the wait and the run moves on. Never assume an
event will wake the step for you; only what the step waits for does.

Only if the user wants the whole step redone from its instructions do they press "Try again" in
the flows UI; a new `▶ flow:` line arrives then.

A refusal (`flow: …`, exit 1) is an answer, not a glitch. `step X has not reached the agent yet`
means you already reported and the next step is on its way — wait for its line.
If `flow show` says no step is active for this session, do nothing and tell the user.
