---
worth: low
where: src/daemon.ts init, reconcileSessions
added: 2026-10-04
---
At start, the `agterm.closed` events from the session check are queued before older events that were stored but not processed before the restart, breaking the strict id order the design asks for. Fix: queue the unprocessed events first.
