# The `flow` command

`flow` talks to flowd over its HTTP API (`src/cli.ts`); only `flow check`, `flow install` and
`flow daemon` work without a running flowd. `bin/flow` runs `node src/cli.ts`; `flow install` puts
a link to it at `~/.local/bin/flow`.

**Finding the step.** Inside an agent's session, `flow` finds the step from `AGTERM_SESSION_ID`:
the open run bound to that session, and that run's current entry if it belongs to the session's
role. Anywhere else, name it with `--run <id> --step <entry>`.

**Refusals.** A refused command prints `flow: <reason>` on stderr and exits 1, for example
`flow: no active step for this session (pr-loop#3 is at ci)` or
`flow: step task-review has not reached the agent yet`. With flowd down it prints
`flow: flowd is not running: launchctl kickstart gui/<uid>/local.flows`.

## For agents

### `flow show`

```
flow show [--run ID --step ENTRY]
```

Prints the current step: a header (run, iteration, step, role, status), the event that woke it,
the run's vars, the rendered prompt and how to report. Works for agent and human steps.

### `flow done`

```
flow done [--note TEXT] [--evidence URL] [--run ID --step ENTRY] [--human]
```

Closes the step as done and prints `recorded done`. An agent can close only its own current step,
and only after its nudge line was typed into its session. That includes its own step that failed
and stopped the run: the agent only gets a turn then because you talked to it, so once it has done
what you asked, its `flow done` moves the run on. The same holds for its own step that waits
for an event again after it had it (a review wait re-armed by `flow failed`): when the awaited
thing will not come, say the PR was merged by hand, the agent's `flow done` ends the wait. A step
that waits and never reached the agent is refused: `step X waits for gh.review and has not
reached you yet`.

### `flow failed`

```
flow failed --note TEXT [--run ID --step ENTRY] [--human]
```

Closes the step as failed; the entry's `on_fail` decides what happens next. `--note` is required.

### `flow set`

```
flow set key=value … [--run ID]
```

Sets run variables, read by later steps as `{{vars.key}}`. Values that are URLs show as links in
the UI. Prints `ok`. Vars are cleared at the start of each iteration.

A pull-request URL under any name but `pr` is stored, with a hint on stderr:
`flow: hint: pull_request looks like a pull request — the standard name is pr (flow set pr=<url>)`.
A Slack thread link under any name but `slack_thread` gets the same kind of hint. See
[Standard variables](processes.md#standard-variables).

### `flow wait`

```
flow wait --note TEXT [--human] [--run ID --step ENTRY]
```

Ends your turn on purpose: you are waiting for something (a background job, the user in a
viewer) and will come back to this step. Prints `waiting: <note>`. Without it, flowd reminds an
agent that ends its turn without reporting and stops the run after the third such turn.

- `--note` is required: what you are waiting for. It shows in the UI, `flow ls` and `flow show`.
- `--human` says a person has to act; the run is then listed under "Waiting for you".
- The wait covers the end of the current turn. When your next turn begins it is used up: finish
  with `flow done` or `flow failed`, or run `flow wait` again with a fresh note.
- Refused like `flow done`: only your own active agent step, after its line reached you.

```
$ flow wait --note "review running in the background; the user picks findings next"
waiting: review running in the background; the user picks findings next
```

## For you

### `flow done --human`

```
flow done --human --run ID --step ENTRY [--note TEXT]
flow failed --human --run ID --step ENTRY --note TEXT
```

Closes any current step, including a human step, from your own terminal. Quote run ids in the
shell: `--run 'pr-loop#3'`.


### `flow start`

```
flow start <process> [--bind role=SESSION …]
```

Starts a run and prints its id (`pr-loop#3`). `--bind` attaches a role to an existing agterm
session id; unbound roles are spawned when their first line is due. Refused when the process is
invalid, already has `max_runs` open runs, or a session is bound to another open run.

### `flow ls`

```
flow ls [--all] [--process NAME] [--where key=value …]
```

One line per open run: id, iteration, status, current entry and its status, what it waits on, and
the reason it stopped. `--all` adds finished runs. Prints `no runs` when there are none.

`--process` keeps one process's runs; `--where` keeps runs whose variable equals the value
exactly (repeat it to require several). A filtered `ls` exits 1 when nothing matches, so a
script can ask "was there a run for this PR":

```
flow ls --all --process review --where pr=https://github.com/o/r/pull/7 >/dev/null || echo new
```

```
pr-loop#3  it.2  running  ci (waiting)  waits gh.checks
demo#1  it.1  needs-human  demo-hello (active)  role agent session closed
pr-loop#4  it.1  running  deploy (waiting)  waits hold desk-1 (pr-loop#3)
```

### `flow signal`

```
flow signal <type> [key=value …] [--run ID] [--outcome done|failed]
```

Sends an event and prints `sent <type>`. A type without a dot gets the `signal.` prefix:
`flow signal deploy-done env=prod` sends `signal.deploy-done` with `data: {env: prod}`. Without
`--run` it is a broadcast: it wakes every entry waiting for that type whose `where` matches, and
starts processes with a matching `on:` trigger.

### `flow check`

```
flow check [name]
```

Validates `$FLOWS_HOME` offline, with the same loader and plugins flowd uses (the repo's
`plugins/`, then `$FLOWS_HOME/plugins/`). It does not need flowd. Prints one line per problem
and exits 1, or a summary and exits 0:

```
$ flow check
process pr-loop: steps[4]: undeclared role dev
step task-pick: summary is required
plugin slack: the default export must be a plugin object with a lowercase name
$ flow check pr-loop
pr-loop is valid
```

With a name it reports only that process or step, and `no process or step named <name>` (exit 1)
when neither exists. The messages are listed in [processes.md](processes.md#validation).

### `flow install`

```
flow install
```

Sets flows up for the current user, and can be re-run at any time:

| What | Where |
|---|---|
| a link to `bin/flow` | `~/.local/bin/flow` |
| the launchd agent `local.flows`, running `flow daemon` with `RunAtLoad` and `KeepAlive` | `~/Library/LaunchAgents/local.flows.plist`, log in `~/.local/state/flows/flowd.log` |
| agterm hook lines `on status … agterm-hook` and `on session.closed … agterm-hook`, then `agtermctl hooks reload` | `~/.config/agterm/hooks.conf` |
| a Claude Code `PostCompact` hook running `flow claude-hook compacted` (a backup is written first) | `~/.claude/settings.json`, backup `settings.json.bak-flows` |
| links to the `flow` and `flow-author` skills | `~/.claude/skills/flow`, `~/.claude/skills/flow-author` |

The hooks and the plist call node by its absolute path (found with `command -v node` in a login
shell) and `src/cli.ts` in this checkout. A re-install replaces flows' own hook lines, hook entry
and skill links, so run it again after moving the repo or upgrading node under nvm. Other hooks
and settings are left alone.

### `flow daemon`

```
flow daemon
```

Runs flowd in the foreground on `127.0.0.1:7420` (`FLOWD_HOST`, `FLOWD_PORT` override). This is what the
launchd agent runs. Stops on `SIGTERM` or `SIGINT`.

### `flow help`

Prints the command summary. So do `flow`, `flow --help` and `flow -h`.

## Hook entry points

Not for hand use; `flow install` wires them.

| Command | Called by | Does |
|---|---|---|
| `flow agterm-hook` | agterm, on `status` and `session.closed` | Posts `AGT_EVENT_KIND`, `AGT_EVENT_STATUS` and `AGT_SESSION_ID` to `/agterm`. |
| `flow claude-hook compacted` | Claude Code's `PostCompact` hook | Posts the session's `AGTERM_SESSION_ID` to `/claude`. |

Both give up after 2 s, never print and always exit 0, so a stopped flowd never slows agterm or
Claude down.

## Environment

| Variable | Used by | Meaning |
|---|---|---|
| `AGTERM_SESSION_ID` | `flow` in an agent's session | Set by agterm; tells `flow` which session is asking. |
| `FLOWD_URL` | `flow` | Where flowd is. Default `http://127.0.0.1:7420`. |
| `FLOWD_HOST` | `flow daemon`, `flow install` | The address flowd listens on. Default `127.0.0.1`. `0.0.0.0` lets a phone on your Wi-Fi open `http://<the Mac's IP>:7420` — and lets anyone on that network drive flowd (see [architecture](architecture.md#security-model)). `flow install` writes it into the launchd plist when set, and keeps the one already there otherwise. |
| `FLOWD_PORT` | `flow daemon`, `flow` | The port flowd listens on, and the CLI's default port. Default 7420. |
| `FLOWS_HOME` | flowd, `flow check` | The definitions directory. Default `~/.config/flows`. |
| `FLOWS_STATE` | flowd | The SQLite database. Default `~/.local/state/flows/flows.db`. |
| `FLOWS_AGTERMCTL` | flowd, `flow install` | The `agtermctl` binary. Default `agtermctl` on `PATH`. |
| `FLOWS_AGTERM_APP` | flowd | The app the terminal buttons bring forward with `open -a`. Default `agterm`. |
| `FLOWS_OPEN` | flowd | The command used for that. Default `open`. |
| `FLOWS_LAUNCHCTL` | `flow install` | The `launchctl` binary. Default `launchctl`. |
