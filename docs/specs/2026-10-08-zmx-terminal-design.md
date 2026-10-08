# zmx as a second terminal: agents without agterm

## Problem

flowd can only run agents in agterm: it spawns, types into and reads sessions through
`agtermctl`, and learns that an agent began or ended a turn from agterm's status events. That ties
flows to one GUI app on one Mac. A headless backend lets a process run its agents without agterm,
and later on another machine.

zmx (github.com/neurosnap/zmx) keeps a terminal process alive and lets clients attach to it. agterm
ships it with its own patch (`scripts/zmx-patches/0001-explicit-leadership.patch` in the agterm
repo), which adds what automation needs: `zmx type` (text as key presses, each CR a Return, encoded
for the program's keyboard mode, queued without taking the lead) and `zmx screen` (the screen and the
cursor). Taking that zmx keeps sessions the same kind agterm runs, so attaching them in agterm later
is natural.

## Goals

- A process can choose its terminal: `terminal: zmx` (default `agterm`, as today). Only new spawns
  use it; runs and other processes are unaffected.
- With zmx, flowd spawns, types, reads and closes sessions through the `zmx` CLI, in its own socket
  directory.
- Agents learn nothing new: a step looks the same, `flow` finds its session, turns are tracked.
- A person can watch or take over a zmx session: the UI's terminal button opens it in agterm.

## Non-goals (later specs)

- Running flowd or agents on another machine (Linux build of the patched zmx, systemd, remote UI).
- agterm listing zmx sessions it did not create.
- Binding an existing zmx session with `--bind` (spawned sessions only, first).

## Decisions

**Terminal interface.** `Agterm` becomes `Terminal` (spawn, type, press, text, cursorColumn, tree,
focus, close?); `realAgterm` stays; `zmxTerminal` is the second implementation in `src/zmx.ts`.
flowd picks the terminal per run from the process's `terminal`, and remembers it in the session row
so a later edit of the process does not orphan a live session.

**zmx specifics** (checked against agterm's zmx 0.8.1):
- Binary: `FLOWS_ZMX`, else `zmx` on `PATH`, else `/Applications/agterm.app/Contents/MacOS/zmx`.
- Socket directory: `ZMX_DIR=~/.local/state/flows/zmx` — never agterm's `/tmp/agterm-zmx-*`, whose
  `zmx prune` kills daemons no agterm pane claims. The path must stay short (unix socket limit).
- Session name: `flows-<process>-<n>-<role>`, characters outside `[A-Za-z0-9._-]` replaced; labels
  `run=<process>.<n> role=<role>` (`#` is not allowed in labels).
- Spawn: `zmx run <name> -d exec /bin/zsh -lc '<spawn> <first line>'` in the role's cwd, with
  `FLOW_SESSION=<name>` in the environment; then `zmx set <name> run=… role=…`. `exec` makes the agent
  the session's process, so the session ends with it.
- Type: the text, then a pause, then `\r` alone, each through `zmx type` (as agterm does: Claude reads
  a Return in the same burst as long text as a paste). Press (the trust dialog's Down): `zmx send`.
- Read: `zmx screen <name>` — the header's cursor column feeds the existing draft check
  (`EMPTY_INPUT_COLUMN`); the text feeds the trust-dialog check.
- Closed: a session missing from `zmx list` is closed; the tick checks the zmx sessions runs hold
  (every 5 s, one `zmx list`).
- Focus (UI terminal button): `agtermctl session new --command "env ZMX_DIR=… zmx attach <name>"`
  plus bringing agterm forward; without agterm the UI shows the attach command to copy.

**Turn signals from Claude Code.** agterm learns turns from Claude Code hooks
(`UserPromptSubmit`/`PostToolUse` active, `Stop` completed, `Notification: permission_prompt`
blocked). For zmx sessions flowd takes the same hooks directly: `flow install` adds
`flow claude-hook <active|completed|blocked>` beside the existing `compacted`, and the hook posts
`FLOW_SESSION` with Claude's own `session_id` from the hook's stdin. A session the hook reports for
must be a zmx session flowd spawned; agterm sessions keep their agterm status path, so nothing is
counted twice.

A `claude -p` an agent starts inside its session inherits `FLOW_SESSION`; its `Stop` must not end the
agent's turn. flowd remembers the Claude `session_id` the session's agent reports first (its
`SessionStart`, source `startup`), takes later events only from that id, and moves to a new id only
on a `SessionStart` with source `clear`, `compact` or `resume` (the same agent after `/clear`).

**Finding the session.** `flow` uses `FLOW_SESSION`, else `AGTERM_SESSION_ID` (not `ZMX_SESSION`:
agterm's live mode sets it in every pane, naming agterm's daemons).

**Install.** Hooks change `~/.claude/settings.json`: `flow install` does it, and a human runs it.

## Testing

- `src/zmx.ts` against a fake `zmx` script (argv and stdin recorded, canned `list`/`screen` output):
  spawn argv, env and labels; type as text then CR; cursor parsed from the `screen` header; a missing
  session reads as closed.
- Daemon: a `terminal: zmx` process spawns through the zmx terminal, an agterm process through agterm;
  hook statuses move a zmx session's turn; a nested `session_id` is ignored; `/clear` moves it.
- CLI: `FLOW_SESSION` wins over `AGTERM_SESSION_ID`.
- By hand, once, before calling it done: a real `terminal: zmx` demo run with Claude — first prompt,
  `flow done`, the next line typed and submitted, the trust dialog answered, the UI button opening it
  in agterm. The run spawns an agent, so it needs the user's go.
