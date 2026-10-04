# flows: local agent processes built from steps

Status: design agreed 2026-10-04 (the maintainer, Claude). Not implemented yet.

## Problem

The user runs several long agent programmes on a Mac, each in agterm sessions: a long
JS→TS migration in a large monorepo and two observability programmes. Each needs to be
started, run in iterations, restarted, and woken by things that happen outside the session
(an iteration ended, CI finished, later a Slack message). Today every programme carries its
own manager skill (the migration's manager skill, one per observability programme), and a
human or a PM agent drives the sessions by hand.

own-pr proved that agents follow a process kept as small step files without trouble, but it
is tied to one pull request per run, the agent pulls every step itself, and nothing outside
the session can push work into it.

## Goals

1. Describe a process once, as an ordered list of reusable steps, and start it, repeat it and
   restart it.
2. A process spans several agterm sessions (roles); the engine, not an agent, moves work
   between them, including `/clear` and `/compact`.
3. Outside events wake a process. Event sources are plugins; Slack must be addable later as
   one file without touching the core.
4. A web UI shows the processes and their steps, lets the user create and edit them, shows the
   running instances and where each stands, and jumps to the agent's agterm session in one
   click.
5. Everything runs locally, in agterm. Sessions are addressed by agterm session id only.

## Non-goals (v1)

Slack plugin; parallel branches and child processes; Codex roles (they need different
`/clear`/`/compact` commands — later a role field `agent:`); authentication; remote machines;
compatibility with own-pr or its journal. Real processes for the migration and the observability programmes are
not shipped — only `examples/ts-wave.yaml` as a sample; the user builds the real ones in the UI.

## Architecture

One long-running Node 24 process, `flowd`, under launchd (`local.flows`), listening on
`127.0.0.1:7420` only. TypeScript runs without a build (Node type stripping); state is in
`node:sqlite`. It holds the engine, the scheduler, the plugin host, the HTTP API, the UI and
the endpoint agterm's status hook posts to. `flow` is a thin CLI over the HTTP API, used by
agents and by the user.

Dependencies: `yaml`, `croner`. Nothing else.

```
src/      daemon.ts engine.ts store.ts defs.ts agterm.ts plugins.ts cron.ts http.ts cli.ts
plugins/  gh.ts
ui/       index.html app.js vendor/preact-htm.js
skill/flow/SKILL.md
examples/ demo.yaml ts-wave.yaml steps/*.md
test/
```

| Unit | Does | Depends on |
|---|---|---|
| `defs` | load and validate steps, processes, plugin config from `$FLOWS_HOME`; write them back for the UI | `yaml` |
| `engine` | pure function `(state, event, defs) → (state', actions[])` | nothing |
| `store` | SQLite tables below; applies engine results in one transaction | `node:sqlite` |
| `agterm` | the only caller of `agtermctl`: spawn, type, focus, tree | `agtermctl` |
| `plugins` | load plugins, call `start`/`watch`/`actions`, isolate their failures | `defs` |
| `cron` | fire process triggers | `croner` |
| `http` | JSON API, SSE stream, static UI, `/agterm` hook endpoint | all of the above |
| `daemon` | wires the units, runs the single event loop, executes actions | all of the above |

## Definitions

Live in `$FLOWS_HOME` (default `~/.config/flows`), may be a git repo. UI, agents and the user all
edit the same files.

```
$FLOWS_HOME/
  steps/<id>.md            reusable step: frontmatter + prompt template
  processes/<name>.yaml    process
  plugins/<name>.ts        user plugins (built-ins ship in the repo's plugins/)
  plugins.yaml             per-plugin config, keyed by plugin name
```

### Step (`steps/<id>.md`)

```markdown
---
summary: PM re-runs the whole gate on the committed tree
---
Re-run the gate in {{vars.worktree}} … Red: `flow failed --note "<what>"`.
```

`summary` is required (one line, shown in UI and PLAN strip). The body is a template:
`{{run.id}}`, `{{run.process}}`, `{{run.iteration}}`, `{{vars.<key>}}`, `{{event.type}}`,
`{{event.outcome}}`, `{{event.data.<key>}}`. No logic, only substitution. A missing key is a
render error: the step does not start and the run goes `needs-human` with the error.

### Process (`processes/<name>.yaml`)

```yaml
description: a long JS→TS migration, one wave per iteration
cwd: ~/code/monorepo
repeat: true
max_runs: 1
triggers:
  - {cron: "0 10 * * 1-5"}
  - {on: flow.iteration.done, where: {process: other-process}}
roles:
  pm:       {spawn: "claude --model opus"}
  executor: {spawn: "claude", cwd: "{{vars.worktree}}"}
steps:
  - {do: clear, role: pm}
  - {step: pick, role: pm}
  - {step: implement, role: executor}
  - {step: gate, role: pm, on_fail: {goto: implement}}
  - {step: pr-open, role: pm}
  - {id: ci, wait_for: gh.checks, on_fail: {goto: fix-ci}}
  - {step: merge, role: human, wait_for: gh.merged}
  - {step: fix-ci, role: pm, detour: true, after: {goto: ci}}
```

Process keys: `description` (required), `cwd` (required), `repeat` (default false),
`max_runs` (default 1), `triggers` (optional; manual start is always possible), `roles`,
`steps` (required, non-empty).

Role: `spawn` (command line that starts the agent) and optional `cwd` (template; defaults to
the process `cwd`). `human` is a reserved role and needs no declaration.

Step entries — exactly one of:

| Entry | Meaning |
|---|---|
| `step: <id>` + `role: <agent role>` | agent step: the rendered prompt goes to the role's session |
| `step: <id>` + `role: human` | human step: shown in the UI, closed by the user |
| `do: clear \| compact` + `role` | session action, executed by flowd |
| `do: type` + `role` + `text` | flowd types a literal line into the role's session |
| `do: <plugin>.<action>` + `with` | plugin action (none ship in v1) |
| `wait_for: <type>` without `step` or `do` | pure wait: the event's outcome closes it |

Common keys on any entry:

- `id` — defaults to the `step` name, else `do`/`wait_for` value; must be unique in the
  process, so a repeated entry needs an explicit `id`. `goto` targets ids.
- `wait_for: <type>` or `{on: <type>, where: {...}, with: {...}}` — the entry waits for a
  matching event before it starts (agent/human) or as its whole job (pure wait).
- `on_fail: retry | {goto: <id>} | human` — default `human`.
- `retries` — failures of this entry allowed per iteration before the run goes
  `needs-human` regardless of `on_fail`; default 3.
- `after: {goto: <id>}` — on `done`, jump instead of advancing to the next entry.
- `detour: true` — normal advancing skips this entry; only a `goto` reaches it (like
  `fix-ci` above). A detour must have `after.goto`. The iteration ends when advancing finds
  no further non-detour entry.
- `timeout: <duration>` (`30m`, `2h`) — `active`/`waiting` longer than this fails the entry.

Validation (on load and on every UI save): known keys only, required keys present, ids unique,
every `goto` target exists, every detour has `after.goto`, every `step` file exists, every agent role declared, every
`wait_for` type declared by a loaded plugin, cron expressions parse. An invalid process is
listed in the UI with its errors and cannot start; other processes are unaffected.

## Runtime model

### Runs

A run is one instance of a process: id `<process>#<n>`, iteration number, status, `vars`,
role bindings. Statuses: `running`, `paused`, `needs-human`, `done`, `stopped`. Exhausted
retries and every other dead end land in `needs-human`, never in a separate failed state.

Entry statuses per iteration: `pending → waiting | active → done | failed | skipped`.

- **Start** (UI, `flow start <process>`, a trigger): refused when `max_runs` open runs exist
  (a trigger that is refused records a `flow.trigger.skipped` event). Each role is either
  bound at start to an existing agterm session id, or spawned lazily when its first entry is
  delivered. A session can be bound to one open run only — that is how `flow` resolves the
  caller. A run started by an event trigger hands that event to its first entry as
  `{{event.*}}`.
- **Advance**: when an entry is `done` the next non-detour entry in list order starts (or
  `after.goto`).
- **Fail**: `on_fail` applies; `goto` resets the target and every entry from it through the
  failed one to `pending`.
- **Iteration end**: past the last entry, `repeat: true` emits `flow.iteration.done`, bumps
  the iteration, resets all entries to `pending` and clears `vars`; otherwise the run is
  `done` and emits `flow.run.done`. What a process must remember between iterations lives in
  its project's files, not in flows.
- **Pause**: nothing is delivered or spawned for the run; events are still recorded and
  applied, deliveries queue until resume.
- **Stop**: the run ends as `stopped`, watches are cancelled, sessions are left alone.
- **Manual overrides** (UI, CLI): mark an entry `done`/`skipped` (with note), `retry`,
  `goto`, rebind or respawn a role.
- **Definition edits** apply to open runs from their next entry. If the entry a run stands
  on was removed, the run goes `needs-human` ("entry X no longer exists").

### Events and the loop

Everything that happens is a row in `events`: agent reports, plugin events, agterm status
changes, UI actions, timers. flowd processes them strictly one at a time in id order: load
state, call `engine`, persist the new state and the actions in one transaction, mark the
event processed, then execute the actions (type into a session, spawn, start/stop a watch).
After a restart, unprocessed events are processed and unsent outbox rows are delivered.

Event shape: `{type, data, outcome?: "done" | "failed", run?, step?, source}`.

- Targeted (`run`/`step` set): applied to that entry only.
- Broadcast: matched against every waiting entry whose `wait_for` type equals the event
  type and whose `where` is a subset of `data`, and against process `triggers` the same way.

`wait_for` resolution:

| Entry | On a matching event |
|---|---|
| pure wait | `done`, or `failed` when `outcome: failed` |
| human | same as pure wait |
| agent | becomes `active`; the event is available to the prompt as `{{event.*}}`; the agent reports the outcome |

### Delivery to agterm sessions

One outbox per session. flowd types into a session only when its agterm status is not
`active`, so nothing lands mid-turn and `/clear` never interrupts work. Consecutive lines to
one session are at least 2 s apart, so a `/clear` is processed before the next line lands.

Agent prompts are not typed in full (a newline would submit early). The session gets one line:

```
▶ flow: step gate · ts-wave#12 it.3 — run `flow show` for the instructions
```

and `flow show` prints the rendered prompt, the waking event, the vars and the report
commands.

Spawn: `agtermctl session new --cwd <role cwd> --command '<spawn> "<that line>"'
--workspace-name <process> --create-workspace --no-select --json`. The first line is passed
as Claude's initial prompt argument, so nothing is typed before the TUI is ready. The
returned session id is stored as the role's binding.

Session actions:
- `clear`: type `/clear`, mark `done`; the next delivery waits for the session to be idle.
- `compact`: type `/compact`, hold the session's outbox, mark `done` when Claude Code's
  `PostCompact` hook reports for that session (`flow claude-hook compacted`, installed by
  `flow install` into `~/.claude/settings.json`). The agterm status cannot be used: it is
  driven by `UserPromptSubmit`/`Stop`, which a slash command does not fire. No report within
  10 minutes fails the entry.

### Turn tracking

agterm's hook lines, installed by `flow install` into `~/.config/agterm/hooks.conf`:

```
on status flow agterm-hook
on session.closed flow agterm-hook
```

`flow agterm-hook` reads `AGT_EVENT_KIND`, `AGT_EVENT_STATUS` and `AGT_SESSION_ID` from its
environment and posts them to `/agterm`; the hook never depends on the payload's shape.

- A status leaving `active` frees the session's outbox.
- An entry delivered to a session that then went `active` and came back to
  `completed`/`idle` without `flow done`/`failed` gets a reminder line 30 s later
  ("step X is not closed: `flow done` or `flow failed`"); after two reminders the run goes
  `needs-human`.
- `session.closed` of a bound session unbinds the role, so its next delivery spawns a new
  session. If the role's agent entry was active at that moment, the run also goes
  `needs-human` with "role X session closed"; the UI offers respawn or rebind.
- On start flowd reconciles statuses from `agtermctl tree --json`.

### Agent CLI

The caller is resolved from `$AGTERM_SESSION_ID` → the open run bound to it → the role's
active entry. `--run ID --step ID` overrides for the user's terminal.

| Command | Does |
|---|---|
| `flow show` | rendered prompt of the active entry, waking event, vars, report commands |
| `flow done [--note T] [--evidence URL]` | close the active entry as done |
| `flow failed --note T` | close it as failed |
| `flow set k=v …` | set run vars (URLs are shown as links in the UI) |
| `flow signal <type> [--run ID] [--outcome done\|failed] [k=v …]` | inject an event (`source: cli`) |
| `flow start <process> [--bind role=SESSION …]` | start a run |
| `flow ls` | open runs, one line each |
| `flow done --human --run ID --step ID` | the user closes a human entry from a terminal |
| `flow install` | launchd plist (generated, machine paths), agterm hook lines, Claude `PostCompact` hook, skill symlink into `~/.claude/skills/flow` |
| `flow agterm-hook`, `flow claude-hook compacted` | hook entry points, not for hand use |

An agent can close a step only after its nudge line has actually been typed into its session
(flowd records that as `entry.delivered`); otherwise a second `flow done` in the same turn would
close the next step of the same role. Lines whose step moved on before they went out are dropped.

A refused command prints why (`no active step for this session`, `step gate is not active`,
`step c has not reached the agent yet`) and exits 1. `flow` against a stopped daemon prints
`flowd is not running: launchctl kickstart gui/$UID/local.flows`.

`skill/flow/SKILL.md` (half a page) tells agents: on a `▶ flow:` line run `flow show`, do
the step, report with `flow done`/`flow failed`; never report what was not verified.

## Plugins

A plugin is a TS module with a default export:

```ts
export default {
  name: "gh",
  events: ["checks", "merged", "review"],        // types it emits: gh.checks, …
  start(ctx) {},                                  // optional: background sources
  watch(w, ctx) { return () => {} },              // optional: w = {run, step, type, with, vars}
  actions: { post(args, ctx) {} },                // optional: `do: gh.post`
}
```

`ctx`: `emit(event)`, `log(msg)`, `config` (its section of `plugins.yaml`).

- `start` runs once at daemon start, for sources that push (a Slack socket, a webhook).
- `watch` is called when an entry starts waiting on one of the plugin's types and stopped
  when it stops waiting; plugins that poll only poll what someone waits for.
- `events` feeds validation and the `wait_for` dropdown in the editor.
- Every call is wrapped: a throw or rejected promise is logged, shown as a red badge on the
  Plugins page and on the waiting entry, and a failed `watch` is retried with backoff. The
  entry does not fail because its plugin did.
- Loaded from the repo's `plugins/` then `$FLOWS_HOME/plugins/` (same name: the user's wins).
  No hot reload: a plugin change needs a daemon restart (the Plugins page has a button).

Built in for v1:

- `gh`: `gh.checks` (all required checks finished; `outcome` done when green, failed
  otherwise; data: failing check names and URLs), `gh.merged` (outcome done when merged,
  failed when closed unmerged), `gh.review` (new review or comment; no outcome). The PR is
  `with.pr` or `vars.pr`. Polls `gh pr view`/`gh pr checks` every 60 s per watched PR.
- `flow` (core, not a file): `flow.step.done`, `flow.step.failed`, `flow.iteration.done`,
  `flow.run.done`, `flow.run.needs-human`, `flow.trigger.skipped`; data carries `process`,
  `run`, `step`.
- `cron` is a trigger kind in the core, not a plugin.

Slack later: `plugins/slack.ts` whose `start` holds Socket Mode and emits `slack.dm` /
`slack.mention` broadcasts, and whose `actions.post` replies in a thread. No core change.

## Storage

`~/.local/state/flows/flows.db` (`FLOWS_STATE` overrides), WAL.

```
runs     (id, process, n, status, state JSON, created, updated)
events   (id, ts, type, run_id, entry_id, outcome, data JSON, source, processed BOOL)
outbox   (id, run_id, role, text, created, sent)
sessions (session_id, status, status_at)          -- last agterm status seen
```

`runs.state` is the engine's whole run state (iteration, vars, role bindings, per-entry
status, attempts, failures, notes, evidence, the waking event, delivery and reminder marks);
`status` is copied out of it for queries. Past iterations are read back from `events`.
Outbox rows name a role, not a session: the session is resolved when the row is sent, so a
row for an unspawned role spawns it.

## HTTP API

JSON over `127.0.0.1:7420`, no auth (localhost only).

- `GET /api/processes`, `GET|PUT /api/processes/:name` (PUT carries the file text and the
  mtime it was based on; a newer file on disk returns 409), `DELETE` likewise.
- `GET /api/steps`, `GET|PUT|DELETE /api/steps/:id` — same contract.
- `GET /api/runs?status=`, `GET /api/runs/:id` (entries, roles, vars, events),
  `POST /api/runs` (start), `POST /api/runs/:id/{pause,resume,stop}`,
  `POST /api/runs/:id/entries/:entry/{done,skip,retry,goto}`,
  `POST /api/runs/:id/roles/:role/{rebind,respawn}`.
- `POST /api/sessions/:id/focus` → `agtermctl session select --target :id`.
- `GET /api/sessions` → `agtermctl tree --json`, for the bind picker.
- `POST /api/events` (what `flow signal`/`done`/`failed` use), `GET /api/stream` (SSE tail
  of `events` plus run updates).
- `GET /api/plugins`, `POST /api/restart`.
- `POST /agterm` — the hook endpoint.

## UI

Served by flowd at `/`, Preact + htm vendored as one ESM file, no build, live via SSE.

1. **Runs (home).** `needs-human` first, then running, then recent finished. A row: run id,
   iteration, current entry and status, what it waits on, vars links, one `↗` per role
   (focus that agterm session). `Start` button with process picker.
2. **Run.** The entry strip (`✓clear ✓pick ▶gate · pr-open · ⏳gh.checks · merge[you]`);
   clicking an entry shows its rendered prompt, notes, attempts, evidence. Actions: done,
   skip (reason required), retry, goto here, pause/resume, stop. Roles with session, agterm
   status, `↗`, respawn, rebind (picker over live sessions). Vars, the run's event log,
   past iterations.
3. **Processes.** List with description, triggers, open runs, `Run` (form binding each role
   to `spawn new` or a live session id). Editor: header form (description, cwd, repeat,
   max_runs, triggers, roles), entries as cards reordered by native drag and drop, each with
   its kind, role, `wait_for` (dropdown from plugin `events`), `on_fail`, `retries`,
   `timeout`, `after`. A raw YAML tab for anything the form does not cover.
4. **Steps.** Library with summary and "used by". Editor: markdown textarea, placeholder
   hints, preview rendered against a chosen run.
5. **Plugins.** Loaded plugins, their event types and actions, active watches, last error,
   restart button.

Saving sends the file to flowd, which validates it with the same loader; an invalid file is
not written and the errors are shown next to the fields. Edits made on disk are picked up by
`fs.watch` and pushed to open pages.

## Errors

| Case | Handling |
|---|---|
| `agtermctl` fails or the session is gone | 3 retries with backoff, then `needs-human` "role X session unavailable" |
| `flow done` from a session with no active entry, or for another entry | refused with the reason, exit 1 |
| `retry`/`goto` loop | `retries` per entry per iteration, then `needs-human` |
| template render error | entry does not start, `needs-human` with the error |
| plugin throws | logged, badge in UI, `watch` retried with backoff; entry unaffected |
| flowd down | `flow` prints the kickstart command |
| concurrent edit (UI vs disk) | mtime check, 409, UI offers reload |
| invalid definition on disk | process marked invalid, its runs do not advance (`needs-human`), others run |

## Testing

`node:test`, no framework.

- **Engine**: the bulk. Pure `(state, event) → (state', actions)` cases for advance, fail
  with each `on_fail`, `retries` exhaustion, `goto` reset range, `after.goto` and detours, repeat and
  iteration reset, `wait_for` for each entry kind, broadcast `where` matching, triggers and
  `max_runs`, reminders, session closed, pause, definition edit removing the current entry.
- **defs**: validation errors for each rule above.
- **Integration**: flowd on a temp DB and temp `$FLOWS_HOME` with a fake `agtermctl` on
  PATH that logs its calls. Scenario: start → spawn role → nudge line → `flow show` →
  `flow done` → `clear` → `flow signal` closes a pure wait → human entry closed via API →
  iteration 2 starts.
- **Manual smoke** on live agterm with `examples/demo.yaml`, covering spawn, clear, compact
  and the jump from the UI.
