# A role in the split pane of another role's session

## Problem

The user's daily setup is one agterm session with Claude on the left and Codex on the right,
talking to each other (a peer-chat skill). flowd only spawns agents into the main pane of new
sessions. Worse, agterm reports the status of either pane on the session, so an agent in the split
pane would move the turn of the flows agent on the left.

## What was checked by hand (agterm, 2026-10-14)

- `session split on` opens the split with a login shell; there is no command option, so the agent's
  command is typed into that shell (`session type --pane right`), and runs.
- Both panes share `AGTERM_SESSION_ID`; `AGTERM_PANE` is `left` or `right`.
- Status events carry the pane: `{"status":"active","pane":"right"}`; the tree has `statusPane`,
  `hasSplit`, `splitForegroundShell` (the split's shell at its prompt), `splitCwd`, `paneOverlays`.
- Closing the split arrives as `pane.split` `hidden`, the same as hiding it.

## Decisions

- The split pane is a session of its own, `<agterm id>:right`; a bare id stays the main pane, so
  nothing existing changes. `src/agterm.ts` maps the suffix to `--pane right`, to the right surface
  for the draft check, to `session focus split` for the terminal button; its tree lists the split
  as a session when there is one, with the status agterm says is its.
- A role's `beside: <role>` puts it in that role's split pane. flowd opens the split, waits for the
  shell, types `cd <cwd> && <spawn> '<first line>'`. A host role without a session is started first
  with no line. One role per split, no chains, agterm only (`flow check`).
- The agterm hook reads the pane from the event on stdin; a right-pane status goes to
  `<id>:right`, a scratch-pane one is ignored.
- `flow` in the split pane is `<AGTERM_SESSION_ID>:right` (`AGTERM_PANE=right`).
- A closed session closes its split pane too; a split pane gone from the tree is closed on the tick.

## Not now

A bottom split, the scratch pane, Restore session into a split.

## Testing

`src/agterm.ts` against a fake `agtermctl` (pane flags, tree, focus, spawnBeside), defs (`beside`
rules), daemon (beside after its host, host started first, pane statuses, closing both, a gone split
on the tick), CLI (`AGTERM_PANE`, the hook's pane). By hand: `spawnBeside` against the real agterm
with a harmless command (no agent).
