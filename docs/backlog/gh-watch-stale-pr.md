---
worth: medium
where: plugins/gh.ts, src/daemon.ts
added: 2026-10-04
---
A watch receives the run's vars as they were when the wait started. If `vars.pr` was not set yet, the gh watch throws and every retry reuses the same snapshot, so a later `flow set pr=…` is never seen and the wait never ends. Fix: re-read the run's vars when re-arming a failed watch, or pass a getter.
