---
worth: low
where: src/daemon.ts startRun, role.bind
added: 2026-10-04
---
One session can be bound to two roles of the same run, at start or by rebind. `flow` then resolves the session to the first role only, so the agent cannot close the second role's steps. Fix: refuse a session already bound to another role of the same run.
