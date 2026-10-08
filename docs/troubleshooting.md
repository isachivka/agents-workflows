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
- Is the session busy? flowd types only into a session whose agterm status is neither `active`
  nor `blocked`, so a line waits for the agent's turn to end, and for a permission prompt to be
  answered. A session that stays `active` or `blocked` holds its lines.
- Was the session just spawned? Nothing is typed into it for 15 s.
- Is the role bound? The run page shows each role's session and its agterm status. A role whose
  session was closed gets a new one on its next line.

## A line was typed but not submitted

The line sits in the agent's input box and nothing happens. flowd sends the text and the Enter
separately with a 500 ms pause; a slow terminal can still miss the Enter. Two minutes later the
start watchdog stops the run with "the agent has not started" (next section).

- Fix: press Enter in that session, or `printf '\n' | agtermctl session type --stdin --target <session>`.
  The agent then runs `flow show` and carries on, and the run resumes by itself.

## A line is queued but never typed while you work in the session

flowd does not type into a session while you are typing in it (its caret is past the prompt) or
while it has an overlay open (a review viewer, for example), so a reminder cannot get glued to
your half-written message. A greyed suggestion in an empty input box does not count. The line
goes out within a second after you send or clear the draft, or close the overlay.

- Check: `agtermctl surface cursor --target surface:<session id>:left` prints 2 for an empty
  input box; `agtermctl tree --json` shows the session's `overlay`.

## A run stopped with "the agent has not started 2 min after its line was delivered"

flowd typed (or spawned with) the step's line, and the agent's session never went `active`.
Something in that terminal holds the agent: a dialog, a login or update prompt, a line that did
not submit, an agent that crashed on start.

- Check: open the session (`↗` on the run page) and look.
- Fix: deal with whatever is on the screen. As soon as the agent starts its turn the run resumes
  by itself. If the session is gone, use **respawn** on the run page.

## A run stopped with "Claude Code asks whether to trust <folder> and flowd could not …"

flowd answers Claude's folder-trust dialog by itself (Down, then Enter on "Yes, I trust this
folder"). This stop means it could not: the dialog looked different, the selection did not move,
or `agtermctl` failed.

- Fix: open the session (`↗`), choose "Yes, I trust this folder". The agent starts and the run
  resumes by itself. Claude remembers the folder, so the next spawn there does not ask.

## `compact` never finishes

The entry stays active and fails after 10 minutes.

- Check: `grep -n "claude-hook compacted" ~/.claude/settings.json`. The `PostCompact` hook must
  call this checkout's `src/cli.ts` with a node that exists.
- Fix: `flow install` (it replaces its own hook entry).

## Turns are not tracked (no reminders, lines wait forever)

- Check: `agtermctl hooks list`. The two `… agterm-hook` lines must be there, without failures.
- Fix: `flow install`, which rewrites them and runs `agtermctl hooks reload`.
- A zmx session (`terminal: zmx`) gets its turns from Claude Code's hooks instead: `~/.claude/settings.json`
  must have flows' `claude-hook start|active|completed|blocked|idle` entries. `flow install` writes them;
  a Claude already running keeps the hooks it started with.

## Looking at a zmx session

- List them: `ZMX_DIR=~/.local/state/flows/zmx zmx list` (agterm's zmx is
  `/Applications/agterm.app/Contents/MacOS/zmx`). Each is labelled with its run and role.
- Watch or take over one: the run's terminal button, or
  `ZMX_DIR=~/.local/state/flows/zmx zmx attach flows-<process>-<n>-<role>-<k>`; detach with zmx's
  detach key, which leaves the agent running.
- Agents of finished runs keep running until they exit: `zmx kill <name>` ends one.
- Never point agterm's own zmx commands (`zmx prune`) at this directory, or flows' at agterm's
  `/tmp/agterm-zmx-*`: prune kills sessions no agterm pane claims.

## After a node upgrade (nvm) nothing works

The plist and the hooks call node by its absolute path, which nvm changes with every version.

- Fix: `flow install` again. It replaces flows' own hooks and links.

## A trigger on a plugin event never starts the process

- Check the Processes page (or `GET /api/processes`): a trigger whose plugin refused it shows
  `trigger: <type>: <error>` under the process, for example `gh.checks needs a PR …; to start on
  CI results use gh.ci`. Settings → Plugins lists the subscription as `trigger · <process>`.
- Plugin triggers see only what happens after their first poll: an older merge or a CI run that
  finished before flowd started (or while it was down) never fires.
- For `gh`: `gh auth status` must pass for the user flowd runs as, and the process `cwd` must be
  inside the repository, or the trigger must name it with `with: {repo: owner/name}`. Polls run
  every 60 s by default (`interval_ms` in `plugins.yaml`).
- `where` must match the event's data exactly (values compared as strings), for example
  `where: {conclusion: failure}` for `gh.ci`.
- `max_runs` reached: an event trigger's run is `queued` and starts when a run of the process ends;
  a cron trigger is skipped and `flow.trigger.skipped` is recorded.

## A run stopped with "the agent ended its turn N times without flow done/failed"

The agent ended its turn three times without reporting. Often it was waiting on purpose (a
background review, the user reading a PR) but did not say so.

- Fix the step's prompt: before the agent ends its turn to wait, it must run
  `flow wait --note "<what for>"` (`--human` when the user acts).
- Then move the run on from the run page: **retry** the step, or **done** if the work is finished.

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
