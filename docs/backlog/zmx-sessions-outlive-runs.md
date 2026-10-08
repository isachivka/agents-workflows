---
worth: medium
where: src/daemon.ts (run end), src/zmx.ts
added: 2026-10-08
---
A zmx agent keeps running after its run ends: nothing closes the session, and `/api/sessions` lists
zmx sessions only while an open run holds one, so the UI no longer shows it. Each finished run
leaves a live Claude process until someone runs `zmx kill`. The recipe in docs/processes.md has the
last step kill its own session, but a run that stops or fails leaves it behind. Fix: a
`Terminal.close` that zmx implements with `zmx kill`, called once a run is terminal and its last
typed line has gone out (a done run still types a final line), perhaps only for `done` so a failed
agent can still be looked at; or list flows' zmx sessions always and offer a close button.
