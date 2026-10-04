---
name: flow
description: Use when a line starting with "▶ flow:" appears in the session, or when the user mentions flowd, `flow show` or `flow done` — this session is a role in a flows process and must take its current step, do it and report it.
---

# flow

This session is one role in a process that flowd runs. flowd types a line like

    ▶ flow: step gate · ts-wave#12 it.3 — run `flow show` for the instructions

when a step is yours. Then:

1. Run `flow show`. It prints the step's instructions, the event that woke it (CI result,
   a merge, a signal) and the run's variables.
2. Do the step as written.
3. Report once: `flow done [--note "…"] [--evidence URL]`, or `flow failed --note "what went wrong"`.
   Never report what you did not verify.
4. Values later steps need go into run variables: `flow set pr=<url>`, `flow set worktree=<path>`.
5. After reporting, end your turn. The next step arrives as a new `▶ flow:` line.

A refusal (`flow: …`, exit 1) is an answer, not a glitch. `step X has not reached the agent yet`
means you already reported and the next step is on its way — wait for its line.
If `flow show` says no step is active for this session, do nothing and tell the user.
