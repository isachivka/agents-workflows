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
- A line whose step moved on before it went out is dropped.
- An agent can close a step only after its line was typed: an early `flow done` is refused with
  `step <id> has not reached the agent yet`. This stops a double `flow done` from closing the next
  step of the same role.

## Sessions and roles

- A role without a session is spawned when its first line is due:
  `agtermctl session new --command "/bin/zsh -lc '<spawn> <first line>'"` in the workspace named
  after the process, session name `<run> <role>`. The first line is the agent's first prompt.
  A login shell puts `claude` on `PATH`, but your `.zshrc` aliases are not loaded.
- A role can be bound to an existing session at start (`flow start <process> --bind role=SESSION`,
  or the Start form). A session can be bound to one open run only; that is how `flow` finds the
  caller.
- A closed session unbinds its role. The run stops (`role <role> session closed`) only if that
  role was in the middle of a step; otherwise its next line spawns a new session.
- **Respawn** forgets the session (the next line spawns a new one); **rebind** points the role at
  another live session. Either re-sends the current step's line if that role was working on it,
  and lifts a halt that role caused.

## Reminders and timeouts

- An agent that ends its turn (session goes `active` → `completed`/`idle`) without `flow done` or
  `flow failed` gets a reminder line 30 s later. After 2 reminders the next missed turn stops the
  run. A session that is `blocked` (waiting on a permission prompt) has not ended its turn.
- An entry's `timeout` fails it when it stays `active` or `waiting` that long. `compact` fails
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
- **Broadcast** events wake every run whose current entry waits for that type and whose `where`
  is a subset of the event's `data` (values compared as strings). They also start every process
  whose trigger matches the same way.
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
- `{on: <type>, where: {...}}` starts a run when a matching event arrives. The run's first
  entry gets that event as `{{event.*}}`, in the first iteration only.
- A start is refused when the process already has `max_runs` open runs. A refused trigger records
  `flow.trigger.skipped`. You can always start a process by hand.
