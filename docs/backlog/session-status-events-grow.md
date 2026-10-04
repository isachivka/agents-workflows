---
worth: low
where: src/store.ts, src/daemon.ts
added: 2026-10-04
---
Every agterm status change of every session, bound to a run or not, is stored as an event forever. `runEvents` also matches `json_extract(data, '$.run')`, which scans the whole table, and the run page re-reads it on every update. Over months this slows the UI. Fix: do not store status events for unbound sessions, or prune old processed ones.
