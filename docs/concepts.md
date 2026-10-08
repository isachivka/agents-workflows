# Concepts

How flows thinks about work. For every key of the files see [processes.md](processes.md); for
the moving parts inside the daemon see [architecture.md](architecture.md).

## The pieces

| Piece | What it is |
|---|---|
| **step** | A reusable prompt in `steps/<id>.md`: a one-line `summary` and a body with `{{placeholders}}`. |
| **process** | An ordered list of entries in `processes/<name>.yaml`, plus the roles that run them. |
| **role** | A named agent in a process (`lead`, `dev`). Each role is one agterm session per run. `human` is the built-in role for you. |
| **run** | One instance of a process, id `<process>#<n>` (`pr-loop#3`). It has an iteration number, vars and role bindings. |
| **entry** | One line of a process's `steps:` list: an agent step, a human step, a session action, a plugin action or a pure wait. |
| **event** | Anything that happens: an agent report, a plugin event, a session status change, a UI action. Every event is stored. |
| **plugin** | A TypeScript module that emits events (`gh.checks`) and offers actions. See [plugins.md](plugins.md). |
| **flowd** | The daemon. It holds the engine, the database, the plugins, the HTTP API and the web UI. |
| **`flow`** | The CLI that agents and you use to talk to flowd. See [cli.md](cli.md). |

## A run's life

Run statuses (`src/types.ts`):

| Status | Meaning |
|---|---|
| `running` | The engine moves it forward. |
| `paused` | Nothing is delivered or spawned; events are still recorded and applied, lines queue until resume. |
| `needs-human` | Stopped with a reason (a failed step, a closed session, a template error, exhausted retries). Like `paused`, nothing is delivered or spawned until a human override moves it on. |
| `done` | The last entry finished and the process does not repeat. |
| `stopped` | Stopped by a human. Sessions are left alone. |

```
            start
              │
              ▼
   pause ┌─────────┐  a step fails, a session closes,   ┌─────────────┐
 ┌──────►│ running │───────────────────────────────────►│ needs-human │
 │       └─────────┘◄───────────────────────────────────└─────────────┘
 │   resume │  │ ▲      done / skip / retry / goto / rebind     │
 └──────────┘  │ └──────────────────────────────────────────────┘
               │ past the last entry (repeat: false)
               ▼
            ┌──────┐          stop (from any open status) → stopped
            │ done │
            └──────┘
```

Entry statuses, per iteration: `pending` → `waiting` (for an event) or `active` → `done`,
`failed` or `skipped`.

## Delivery to agents

flowd never pastes a whole prompt into a session: a newline would submit it half-typed. The
session gets one line:

```
▶ flow: step task-review · pr-loop#3 it.2 — run `flow show` for the instructions
```

and `flow show` prints the rendered prompt, the event that woke the step, the vars and how to
report. The rules (`src/daemon.ts`, `src/agterm.ts`, `src/engine.ts`):

- Each role has an outbox. A line goes out only when the session's agterm status is neither
  `active` nor `blocked` (at a permission prompt), so nothing lands mid-turn or answers a dialog.
- The text and the Enter are two `agtermctl session type --stdin` calls with a 500 ms pause
  between them. Claude's composer treats a newline typed together with the text as text.
- Lines to one session are at least 2 s apart. Nothing is typed into a freshly spawned session
  for 15 s.
- flowd never types over the user. A line waits while the session has an overlay open (agterm's
  `overlay`), or while the user is typing in it: the caret of the session's main surface
  (`agtermctl surface cursor`) is past column 2, right after the prompt mark `❯ ` / `› `. The
  caret, not the screen text: after a turn Claude Code draws a greyed suggestion in the empty
  input box, which the screen text cannot tell from typed text. Send or clear the draft and the
  line goes out within a second. When the caret cannot be read, the line goes out as before.
- A line whose step moved on before it went out is dropped.
- An agent can close a step only after its line was typed: an early `flow done` is refused with
  `step <id> has not reached the agent yet`. This stops a double `flow done` from closing the next
  step of the same role.

## Sessions and roles

- A role without a session is spawned when its first line is due:
  `agtermctl session new --command "/bin/zsh -lc '<spawn> <first line>'"` in the process's
  `workspace` (default: its name), session name from the role's `name` (default `<run> <role>`).
  The first line is the agent's first prompt. A login shell puts `claude` on `PATH`, but your
  `.zshrc` aliases are not loaded. A failed spawn is retried up to three times; a retry first looks
  for a session of that workspace and name that no open run has (one an earlier attempt opened
  before its answer was lost, say to a flowd crash) and takes it instead of starting a second agent.
- A role can be bound to an existing session at start (`flow start <process> --bind role=SESSION`,
  or the Start form). A session can be bound to one open run only; that is how `flow` finds the
  caller.
- A closed session unbinds its role. The run stops (`role <role> session closed`) only if that
  role was in the middle of a step; otherwise its next line spawns a new session.
- **Respawn** forgets the session (the next line spawns a new one); **rebind** points the role at
  another live session. Either re-sends the current step's line if that role was working on it,
  and lifts a halt that role caused.

## Reminders and timeouts

- A turn ends when the session reports `completed` (Claude's and Codex's `Stop` hooks). `idle` is
  not a turn end: agterm sets it when it clears a status, for example on the user's first
  keystroke in the session. One exception: a session that was `active` before flowd restarted
  and is cleared afterwards counts as `completed`, because its turn ended while flowd was down.
- An agent that ends its turn (session goes `active` → `completed`) without `flow done` or
  `flow failed` gets a reminder line 30 s later. After 2 reminders the next missed turn stops the
  run. A session that is `blocked` (waiting on a permission prompt) has not ended its turn.
- An agent that ends its turn **on purpose** (a review runs in the background, the user is reading
  a PR in a viewer) says so first: `flow wait --note "<what for>"`. The wait covers the end of the
  turn it was declared in, and any repeat of that turn end (agterm can report a status twice); no
  reminder follows. When the agent's next turn begins, the wait is used up: a turn that then ends
  without a report is reminded as usual. Each `flow wait` resets the reminder count, so a step may
  wait legitimately any number of times. A turn agterm never sees (no `active`) does not use the
  wait up.
- A wait shows on the run: `waiting since <time>: <note>` on the run page (the run's current step) and in
  `flow show`, `waiting: <note>` on the Now page and in `flow ls`. With `--human` the wait is on a
  person and the run is listed under "Waiting for you".
- A line that reaches an agent must start its turn. If the session has not gone `active` 2 minutes
  after a nudge or a reminder was delivered (and the step has no `flow wait`), the run stops for
  the user: "the agent has not started 2 min after its line was delivered". It clears itself:
  the agent's first `active` on that step resumes the run.
- Claude Code asks "Is this a project you trust?" in every folder it has not been told to trust
  (it does not inherit trust from a parent folder). When flowd spawns `claude` into such a folder
  (per `~/.claude.json`), it answers: it watches the new session's screen for up to 30 s,
  moves the selection to "Yes, I trust this folder" and presses Enter. A process that spawns an
  agent into a folder has already decided to trust it. If flowd cannot select "Yes", the run stops
  with the reason and resumes on the agent's first `active`. flowd never writes `~/.claude.json`;
  Claude records the answer itself.
- An entry's `timeout` fails it when it stays `active` or `waiting` that long, whether or not its
  agent declared a wait. `compact` fails
  after 10 minutes without a report. Timeouts do not run while the run is paused.

## clear and compact

- `{do: clear}` types `/clear` and is done at once. The next line waits for the session to be idle.
- `{do: compact}` types `/compact` and is done when Claude Code's `PostCompact` hook reports for
  that session (`flow claude-hook compacted`, installed by `flow install`). agterm's status cannot
  be used: a slash command does not fire the hooks it is driven by.
- Both are done at once, with nothing typed, when the role has no session yet: a fresh session
  needs neither.

## Events

Every event has a `type`, `data`, an optional `outcome` (`done` or `failed`) and a `source`.

- **Targeted** events name a run (and maybe an entry) and apply to that run only.
- **Broadcast** events (core `flow.*` events, `flow signal`, events a plugin pushes from `start`)
  wake every run whose current entry waits for that type and whose `where` is a subset of the
  event's `data` (values compared as strings). They also start every process whose trigger matches
  the same way. An event from a trigger subscription is narrower: see below.
- Ad-hoc events are `signal.<name>`. `flow signal deploy-done` sends `signal.deploy-done`.

The core emits these (`src/defs.ts` `CORE_EVENTS`, `src/engine.ts`). Every one carries
`process` and `run` in `data`, except `flow.trigger.skipped`, which has no run:

| Event | Extra `data` |
|---|---|
| `flow.step.done` | `entry`, `note` |
| `flow.step.failed` | `entry`, `note` |
| `flow.iteration.done` | `iteration` |
| `flow.run.done` | `iteration` |
| `flow.run.needs-human` | `reason` |
| `flow.trigger.skipped` | `process`, `trigger` |

A process can wait on them (`wait_for: {on: flow.run.done, where: {process: build}}`) or be
triggered by them.

## Triggers

- `{cron: "0 10 * * 1-5"}` starts a run on a schedule (croner syntax).
- `{on: <type>, with: {...}, where: {...}}` starts a run when a matching event arrives. The run's
  first entry gets that event as `{{event.*}}`, in the first iteration only.
- A triggered run starts with the event in its vars: every scalar field of the event's `data`
  as a string (`vars.pr`, `vars.number`, `vars.branch`, …) and `vars.trigger` = the event type.
  So a later `wait_for: gh.checks` finds `vars.pr` with no `flow set`.
- At `max_runs` a start by hand or by an event is `queued`: the run exists with its vars and bound
  sessions and starts by itself, oldest first, when a run of the process ends (its sessions are
  told when their place changes). A cron start is skipped instead and records
  `flow.trigger.skipped`; a schedule fires again.

## Subscriptions: how a plugin hears about waits and triggers

A plugin learns that someone wants its events through one call, `watch()`. Both kinds of
interest are subscriptions:

- A **wait** (an entry with `wait_for: gh.checks`) is a subscription for one entry of one run. The
  plugin emits to that entry, once, and the watch stops when the entry stops waiting.
- A **trigger** (`triggers: [{on: gh.merged, with: {base: main}}]`) is a standing subscription
  with no run. Identical triggers (same type, `with` and process `cwd`) in several processes share
  one subscription, so one merge is one event for all of them. Its events go only to the processes
  that asked for that subscription, each through its trigger's `where`; they wake no waiting entry
  (a wait has its own watch), and a trigger with a different `with` or `cwd` does not see them.
- flowd brings trigger subscriptions in line with the definitions on every load: new ones are
  started, removed ones stopped, unchanged ones left running, so a plugin keeps its state (gh's
  list of PRs already seen) through an unrelated edit.
- A plugin that polls takes its first poll as a baseline and reports only what is new after it.
  Nothing is caught up after flowd was down: a restart starts from a new baseline.
- `flow.*` and `signal.*` events need no plugin and no subscription. A trigger whose plugin cannot
  serve it (for example `gh.checks`, which needs a PR) shows its error under the process and on
  Settings → Plugins.
