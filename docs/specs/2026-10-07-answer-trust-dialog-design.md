# flowd answers Claude's folder-trust dialog

Status: approved 2026-10-07 by the user. Supersedes decision 2 of
`2026-10-07-agent-start-watchdog-design.md` ("flowd never answers the dialog").

## Problem

Every new folder (a fresh worktree per task) makes Claude Code ask "Is this a project you
trust?" before it reads the step. Claude does not inherit trust from a trusted parent folder, so
a process that works in a new worktree per item needs a human click per item. The user had
flowd's session answered by hand (arrow down, Enter) and wants flowd to do it.

A role spawned by a process already runs an agent in that folder, usually with
`--dangerously-skip-permissions`: the process author has decided to trust it. The dialog adds a
click, not a safeguard.

## Decision

After spawning a role whose `spawn` runs `claude` into a folder `~/.claude.json` does not mark as
trusted, flowd watches the new session's screen (`agtermctl session text`, every second, up to
30 s):

- When "Yes, I trust this folder" is on screen and not selected, it presses Down
  (`agtermctl session type --stdin` with `ESC [ B`), reads the screen again, and presses Enter
  only when the selection marker `❯` is on the "Yes" line.
- If the dialog never shows up, it does nothing (the start watchdog still covers any hang).
- If it cannot select "Yes" or an `agtermctl` call fails, it stops the run for the user as
  before, with the reason, and the run resumes on the agent's first `active`.

It runs beside delivery (not in the flush loop), so other sessions are not held up.
flowd still never writes `~/.claude.json`; Claude records the answer itself.

## Testing

Daemon with a fake agterm whose screen shows the dialog: Down then Enter are pressed, no stop;
a selection that does not move → no Enter, stopped with the reason; no dialog within the window
→ nothing pressed, running; a trusted folder → the screen is never read. Docs: `concepts.md`,
`troubleshooting.md`.
