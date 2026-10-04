# Troubleshooting

Symptom, what to check, what to do. flowd's log is `~/.local/state/flows/flowd.log`.

## `flow: flowd is not running`

- Check: `launchctl print gui/$UID/local.flows` (look at `state` and `last exit code`), and the
  end of the log.
- Fix: `launchctl kickstart -k gui/$UID/local.flows`. If the agent is not loaded at all, run
  `flow install`. To run flowd by hand instead, stop the agent
  (`launchctl bootout gui/$UID/local.flows`) and run `flow daemon` in a terminal.

## flowd exits at start with `EADDRINUSE`

- Check: `lsof -iTCP:7420 -sTCP:LISTEN`. Another flowd (a `flow daemon` in a terminal) or another
  program holds the port.
- Fix: stop it, or run flowd on another port with `FLOWD_PORT` and point the CLI at it with
  `FLOWD_URL`.

## An agent never got its line

- Check `flow ls`: is the run `paused` or `needs-human`? The reason is at the end of the line.
- Is the session busy? flowd types only into a session whose agterm status is not `active`, so a
  line waits for the agent's turn to end. A session that stays `active` holds its lines.
- Was the session just spawned? Nothing is typed into it for 15 s.
- Is the role bound? The run page shows each role's session and its agterm status. A role whose
  session was closed gets a new one on its next line.

## A line was typed but not submitted

The line sits in the agent's input box and nothing happens. flowd sends the text and the Enter
separately with a 500 ms pause; a slow terminal can still miss the Enter, and flowd does not
notice (see [backlog/silent-submit-stuck-step.md](backlog/silent-submit-stuck-step.md)).

- Fix: press Enter in that session, or `printf '\n' | agtermctl session type --stdin --target <session>`.
  The agent then runs `flow show` and carries on.

## `compact` never finishes

The entry stays active and fails after 10 minutes.

- Check: `grep -n "claude-hook compacted" ~/.claude/settings.json`. The `PostCompact` hook must
  call this checkout's `src/cli.ts` with a node that exists.
- Fix: `flow install` (it replaces its own hook entry).

## Turns are not tracked (no reminders, lines wait forever)

- Check: `agtermctl hooks list`. The two `… agterm-hook` lines must be there, without failures.
- Fix: `flow install`, which rewrites them and runs `agtermctl hooks reload`.

## After a node upgrade (nvm) nothing works

The plist and the hooks call node by its absolute path, which nvm changes with every version.

- Fix: `flow install` again. It replaces flows' own hooks and links.

## A process shows as invalid

- Check: `flow check <name>` prints every problem, one per line. The messages are explained in
  [processes.md](processes.md#validation).
- An invalid process cannot start, and its open runs stop within seconds (`needs-human`,
  `process X is invalid or missing`). Fix the file; then use the run page's overrides to go on.

## A run is stuck at a step whose entry was removed

The run is `needs-human` with `entry X no longer exists`. Use **goto** on the run page (or
`POST /api/runs/:id/entries/:entry/goto`) to move it to an entry that exists, or stop it.

## Starting over

Runs and their history live in one SQLite file. To start from nothing:

```bash
launchctl bootout gui/$UID/local.flows
for f in ~/.local/state/flows/flows.db*; do mv "$f" "$f.old"; done
flow install
```

Definitions in `~/.config/flows` are not touched.
