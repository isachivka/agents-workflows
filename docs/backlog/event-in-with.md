---
worth: low
where: src/defs.ts, src/engine.ts renderWith
added: 2026-10-04
---
String values of `with` (plugin action arguments and `wait_for.with`) are rendered from the run and its vars only. `{{event.*}}` there passes validation but always fails at run time, stopping the run. Fix: reject it in the loader as for step bodies, or pass the entry's event to `renderWith`.
