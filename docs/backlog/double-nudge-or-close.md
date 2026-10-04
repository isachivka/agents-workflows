---
worth: low
where: src/daemon.ts, src/engine.ts, ui/app.js
added: 2026-10-04
---
A human retry before the first nudge went out queues a second line for the same step, and both look current, so both are typed. A double click on done in a one-entry repeating iteration closes two iterations. Fix: carry the attempt and iteration in deliveries and reports, and drop or refuse mismatches.
