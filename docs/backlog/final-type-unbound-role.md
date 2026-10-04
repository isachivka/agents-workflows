---
worth: low
where: src/daemon.ts doFlush
added: 2026-10-04
---
A non-repeating process whose last entry is `{do: type}` for a role that never got a session (for
example a process of only human steps and that final `type`) finishes `done` without typing
anything: the finished run's line is dropped instead of spawning a session for it. A done run
types its last line only into a role that is already bound. Fix: decide whether a finished run may
spawn a session for its last line; if not, say so in docs/processes.md and have `flow check` warn.
