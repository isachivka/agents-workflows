---
worth: medium
where: src/engine.ts enter/jump
added: 2026-10-04
---
A `goto` cycle made only of `type` or `clear` entries (for example `{id: a, do: type}` then `{id: b, do: type, after: {goto: a}}`) recurses in one engine step until "Maximum call stack size exceeded". The run is left `running` with no current entry and counts toward `max_runs` for good. The no-work guard covers iteration ends only. Fix: cap the number of entries entered in one step and stop the run past the cap.
