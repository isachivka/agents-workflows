---
worth: medium
where: src/daemon.ts apply/process
added: 2026-10-04
---
Saving a run's new state and marking its event processed are two transactions. A crash between them processes the event again after restart; for `run.start` that creates a second run. Fix: mark the event processed inside the same transaction as the run state.
