# The `flow` command

`flow` talks to flowd over its HTTP API (`src/cli.ts`); only `flow check`, `flow install` and
`flow daemon` work without a running flowd. `bin/flow` runs `node src/cli.ts`; `flow install` puts
a link to it at `~/.local/bin/flow`.

**Finding the step.** Inside an agent's session, `flow` finds the step from `FLOW_SESSION` (a zmx
session) or `AGTERM_SESSION_ID` (an agterm one; `<id>:right` in its split pane):
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

An agent in another session that names the step with `--run`/`--step` is refused: `step X of
RUN is its dev agent's (session …), and flowd gives that agent the steps that follow …`. Two
agents on one run each do the next steps (a review request posted twice); `--human` closes it as
the person instead.

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

### `flow say`

```
flow say TEXT [--file PATH] [--run ID]
```

Writes to the run's conversation in the messenger set up in `plugins.yaml` (a Telegram topic, see
[Chat adapters](plugins.md#chat-adapters)): one conversation per run, opened by its first message.
A nested run writes into the conversation of the run it works for. `--file` attaches a file (an
HTML report); the path is made absolute here and read by flowd. Prints `sent`.

What the person writes back in that conversation is typed into your session once your turn has
ended, as `<name> (<messenger>): <text>`. To wait for it, end your turn with
`flow wait --human --note "…"`.

When flowd serves reports (`FLOWS_REPORTS_URL`, see [`flow publish`](#flow-publish)), an `.html`
file is published and the message carries its link instead of the file: it opens in the phone's
browser. Other files go as files.

Refused when no messenger is set up (`no chat is set up: …`), when the file does not exist, or with
the messenger's own error (`telegram: …`).

```
$ flow say "The plan is ready: your OK or your objections" --file /tmp/plan.html
sent
```

### `flow publish`

```
flow publish FILE
```

Serves a copy of `FILE` (a self-contained HTML report, up to 20 MB) under an unguessable link and
prints it: `<FLOWS_REPORTS_URL>/r/<32 hex>/<name>`. Each call is a new copy and a new link; copies
are deleted after 30 days. The link is the only key — anyone who has it can open the report until
then — so it goes where the person reads (`flow say` does this for `.html` files by itself, or
`flow set report=<url>`), not into public places.

Refused when reports are not served (`reports are not served: set FLOWS_REPORTS_URL`), for a
missing file, a directory, or a file over the limit.

**Serving reports.** flowd serves them on a listener of their own, which answers nothing but
`GET`/`HEAD /r/<token>/<name>` (404 for anything else): the UI and the API stay on their own port.
Set, in flowd's environment (the launchd plist's `EnvironmentVariables`):

- `FLOWS_REPORTS_URL` — the public base of the links, e.g. `https://reports.example.net`. Each host
  running a flowd has its own.
- `FLOWS_REPORTS_PORT` (default `7430`) and `FLOWS_REPORTS_HOST` (default `0.0.0.0`).

Then point an HTTPS reverse proxy at that port — a router's (KeenDNS on a Keenetic:
`ip http proxy reports`, upstream this machine's port 7430), Caddy, a tunnel — and restart flowd.
Only that port is exposed; never expose the UI's.

```
$ flow publish /tmp/plan.html
https://reports.example.net/r/3f9c0a…/plan.html
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
flow start <process> [--bind role=SESSION …] [--var key=value …] [--inner <process|none> …]
```

Starts a run and prints its id (`pr-loop#3`). `--bind` attaches a role to an existing agterm
session id; unbound roles are spawned when their first line is due. `--var` (repeatable) sets run
variables before the first entry starts, so its prompt and a role's `name:` can read them; a value
may hold spaces and `=`: `flow start triage --var title="Fix the login timeout" --var item=42`. In
a repeating process they last for the first iteration, like any vars. Refused when the process is
invalid or a session is bound to another open run — unless that run stands on an `inner` entry
lending that session's agent: then the new run is nested there (see "Nested runs" in
[processes.md](processes.md)) and starts with a copy of that run's vars.

`--inner` (repeatable, in order) names what runs in the process's `inner` entry, then in that
process's `inner`, and so on: `flow start tracker --inner pr --bind dev=$AGTERM_SESSION_ID`.
`none` skips that `inner`. A chain that cannot be placed is refused before anything starts
(`pr has no inner step, so other has nowhere to go`).

When the process already has `max_runs` runs working, the run is created `queued` and the command
still succeeds: `jsf#6 queued: 2nd in line, 5 of 5 runs open` (the id stays the first word). It
starts by itself, oldest first, when one of them ends; its bound sessions are told each time their
place changes. Stop it like any run to drop it from the line.

### `flow ls`

```
flow ls [--all] [--process NAME] [--where key=value …]
```

One line per open run: id, iteration, status, current entry and its status, what it waits on, and
the reason it stopped, and `↳ <run>` for a nested run working in that run's agent. `--all` adds
finished runs. Prints `no runs` when there are none.

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

### `flow skip`

```
flow skip [RUN] --note T
```

Skips the current step of `RUN`, or, without one, of the top run of this session, and goes on to
the next. The usual use: a run waits on its `inner` entry and nothing is to run there. Refused on
an `inner` whose nested run is still open (stop that run first).

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
| Claude Code hooks (a backup is written first): `PostCompact` → `flow claude-hook compacted`; `SessionStart` → `start`, `UserPromptSubmit` and `PostToolUse` → `active`, `Stop` → `completed`, `Notification` (`permission_prompt`) → `blocked`, `Notification` (`idle_prompt`) → `idle`. All but the first run as `[ -z "$FLOW_SESSION" ] \|\| … claude-hook <event>`, so Claude sessions outside flows' zmx sessions never start node for them. | `~/.claude/settings.json`, backup `settings.json.bak-flows` |
| links to the `flow` and `flow-author` skills | `~/.claude/skills/flow`, `~/.claude/skills/flow-author`; with Codex installed (`~/.codex` exists, or `$CODEX_HOME`) also `~/.codex/skills/` |

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
| `flow agterm-hook` | agterm, on `status` and `session.closed` | Posts `AGT_EVENT_KIND`, `AGT_EVENT_STATUS`, `AGT_SESSION_ID` and the pane that set the status (from the event JSON on stdin) to `/agterm`. |
| `flow claude-hook compacted` | Claude Code's `PostCompact` hook | Posts the session (`FLOW_SESSION`, else `AGTERM_SESSION_ID`) to `/claude`. |
| `flow claude-hook start\|active\|completed\|blocked\|idle` | Claude Code's `SessionStart`, `UserPromptSubmit`/`PostToolUse`, `Stop`, `Notification` (`permission_prompt`, `idle_prompt`) hooks | Only with `FLOW_SESSION` set: posts it with Claude's `session_id` (and `source` on `SessionStart`) from the hook's stdin to `/claude`. Without it, exits at once. |

Both give up after 2 s, never print and always exit 0, so a stopped flowd never slows agterm or
Claude down.

## Environment

| Variable | Used by | Meaning |
|---|---|---|
| `FLOW_SESSION` | `flow` and `flow claude-hook` in a zmx session | Set by flowd when it spawns into zmx; tells `flow` which session is asking. Wins over `AGTERM_SESSION_ID`. |
| `AGTERM_SESSION_ID` | `flow` in an agent's session | Set by agterm; tells `flow` which session is asking. |
| `AGTERM_PANE` | `flow` in an agent's session | Set by agterm. `right` (the split pane) makes the session `<AGTERM_SESSION_ID>:right`, as flowd names a role running `beside` another. |
| `FLOWD_URL` | `flow` | Where flowd is. Default `http://127.0.0.1:7420`. |
| `FLOWD_HOST` | `flow daemon`, `flow install` | The address flowd listens on. Default `127.0.0.1`. `0.0.0.0` lets a phone on your Wi-Fi open `http://<the Mac's IP>:7420` — and lets anyone on that network drive flowd (see [architecture](architecture.md#security-model)). `flow install` writes it into the launchd plist when set, and keeps the one already there otherwise. |
| `FLOWD_PORT` | `flow daemon`, `flow` | The port flowd listens on, and the CLI's default port. Default 7420. |
| `FLOWS_HOME` | flowd, `flow check` | The definitions directory. Default `~/.config/flows`. |
| `FLOWS_STATE` | flowd | The SQLite database. Default `~/.local/state/flows/flows.db`. |
| `FLOWS_AGTERMCTL` | flowd, `flow install` | The `agtermctl` binary. Default `agtermctl` on `PATH`. |
| `FLOWS_AGTERM_APP` | flowd | The app the terminal buttons bring forward with `open -a`. Default `agterm`. |
| `FLOWS_OPEN` | flowd | The command used for that. Default `open`. |
| `FLOWS_LAUNCHCTL` | `flow install` | The `launchctl` binary. Default `launchctl`. |
| `FLOWS_ZMX` | flowd | The `zmx` binary for `terminal: zmx`. Default `zmx` on `PATH`, else the one inside `/Applications/agterm.app` (agterm's build has the `type` and `screen` commands flowd needs). |
| `FLOWD_PUBLIC_URL` | flowd | The address a reverse proxy serves the UI under from outside, e.g. `https://flows.example.net`. Requests with that `Host`, and an `Origin` of exactly that address, are flowd's own; everything else foreign is refused as before. Through it the UI needs a login from a login plugin (Telegram: [Logins](plugins.md#logins)); without one only a page saying so is served. Never the reports' name: a report's JavaScript would reach the API. |
| `FLOWD_PUBLIC_FROM` | flowd | The addresses a reverse proxy connects from, comma-separated (a home router: `192.168.1.1`). Every request from them is from outside and needs a login, whatever its `Host`: a proxy that rewrites `Host` to this machine's IP (a Keenetic does, and drops `Origin`) would otherwise look like a LAN client. Set it whenever such a proxy points at flowd. |
| `FLOWS_REPORTS_URL` | flowd | The public base of report links; set, it turns on the reports listener ([`flow publish`](#flow-publish)). Unset: reports are not served, `flow say` sends files. |
| `FLOWS_REPORTS_PORT`, `FLOWS_REPORTS_HOST` | flowd | Where the reports listener listens. Default `7430` on `0.0.0.0`. |
| `FLOWS_PRETRANSLATE` | flowd | Languages every step's prompt is translated into ahead of time, comma-separated, so Translate in the UI answers at once. Default `ru`; empty turns it off. flowd translates 2 minutes after start and 1 minute after a step file changes, one prompt at a time, only while no requested translation runs. |
| `FLOWS_ZMX_DIR` | flowd | zmx's socket directory for flows' sessions. Default `zmx` beside the database (`~/.local/state/flows/zmx`). Keep it short: unix sockets have a path limit. |
