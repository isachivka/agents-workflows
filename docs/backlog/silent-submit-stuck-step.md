---
worth: high
where: src/daemon.ts flush, src/engine.ts reminders
added: 2026-10-04
---
A typed line that never submits (it sits in the agent's composer) leaves its entry `active`
forever. Reminders start only after the session's status went `active` and came back, which
never happens when the agent never got the prompt, so nothing tells the human. This happened in
the first live run, before text and Enter were sent separately. Fix: after a delivery, expect
the session to go `active` within N seconds; otherwise send Enter once more, then stop the run
for the human with a reason.
