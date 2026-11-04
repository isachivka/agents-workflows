---
worth: medium
where: test/daemon.test.ts
added: 2026-11-04
---
# The linked-definition test misses its file event while another suite runs

"a definition linked in from another directory is reloaded when it changes there" waits for the
file event of a rename in a temp directory. Run alone, or in a full `npm test`, it passes in well under a
second; while a second `npm test` runs at the same time on the machine (another checkout, a worktree),
the event did not arrive within 15 s, three times out of three. Nothing else in the suite depends on
file events this way. A fix: drive the reload from the test (call the watcher's handler, or poll
`linkedDirs` on the tick as a fallback the daemon could use anyway, since a missed event leaves a
definition stale until the next edit in the home).
