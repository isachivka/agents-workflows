---
worth: low
where: src/daemon.ts checkZmx / tickNow
added: 2026-10-08
---
`tickNow` awaits `checkZmx` (one `zmx list`, 15 s timeout) before the engine tick, and nothing
stops ticks from overlapping: a hung zmx delays every tick and the checks pile up. One still in
flight when `close()` runs submits into a closed store, an unhandled rejection at shutdown. Fix:
run it through `background()` with an in-flight flag and a `closing` guard.
