# Architecture

One Node 24 process, `flowd`, holds everything. TypeScript runs without a build (Node's type
stripping); state is in `node:sqlite`. The only runtime dependencies are `yaml` and `croner`.

```
  agterm sessions (agents)                       you
   │  ▲  type lines, spawn,                       │ browser          terminal
   │  │  focus, tree                              ▼                    │
   │  └──────────────┐                ┌──────────────────────┐         │
   │ flow show/done… │                │        flowd         │         │
   └──────────────►  │  ┌───────────► │  http (API, SSE, UI) │ ◄───────┘ flow …
     agterm hooks ───┼──┘             │  daemon (event loop) │
     Claude hook  ───┘                │  engine · store      │
                                      │  plugins · cron      │──► gh, … (plugins)
                                      └──────────────────────┘
                                         ~/.config/flows      (definitions)
                                         ~/.local/state/flows (database, log)
```

## Modules

| File | Responsibility |
|---|---|
| `src/types.ts` | Every shared type: definitions, events, run state, engine inputs and actions. |
| `src/template.ts` | `{{path}}` substitution; a missing value throws `RenderError`. |
| `src/defs.ts` | Parse and validate steps and processes, load `$FLOWS_HOME`, read/write/delete definition files with an mtime check. |
| `src/engine.ts` | The pure state machine: `step(run, input, ctx) → {run, actions, error?}`. No I/O. |
| `src/store.ts` | SQLite: runs, events, outbox, session statuses. |
| `src/agterm.ts` | The only caller of `agtermctl`: spawn, type, focus, tree; shell quoting. |
| `src/plugins.ts` | The plugin interface and host: loading, events, watches with backoff, actions. |
| `src/daemon.ts` | `Flowd`: the event loop, routing, executing actions, the outbox flush, ticks, cron, definition reloads, restart recovery. |
| `src/http.ts` | The JSON API, the SSE stream, the static UI, the hook endpoints, the Host/Origin/content-type guard. |
| `src/main.ts` | Starts flowd and the HTTP server. |
| `src/cli.ts`, `bin/flow` | The `flow` command. |
| `src/check.ts` | `flow check`: offline validation with the same loader and plugins. |
| `src/install.ts` | `flow install`: launchd plist, hooks, skill links. |
| `plugins/gh.ts` | The built-in GitHub plugin. |
| `ui/index.html`, `ui/app.js`, `ui/style.css` | The web UI: plain browser JavaScript, no build. |
| `ui/vendor/preact-htm.js` | Preact and htm, vendored as one ES module. |

## An event's path

1. Something happens: `flow done` posts `/api/report`, a plugin calls `ctx.emit`, agterm's hook
   posts `/agterm`, a cron trigger fires. Each becomes `flowd.submit(event)`.
2. The event is stored in `events`, then processed strictly one at a time, in order, on a single
   promise chain.
3. `handle` turns internal events (`run.start`, `entry.report`, `agterm.status`, …) into engine
   inputs; `route` delivers any other event to the run it targets, or broadcasts it to waiting
   entries and triggers.
4. `engine.step` computes the new run state and a list of actions: `deliver` a line, `watch` or
   `unwatch` an event, call a `plugin-action`, `emit` an event.
5. One transaction saves the run, the outbox rows for `deliver`, and the emitted events. Then the
   watches and plugin actions run and the emitted events are queued behind the current one.
6. `flush` walks the outbox: it drops lines of finished runs and lines whose step moved on, holds
   lines of paused runs, spawns a role that has no session, waits while the session is `active`
   or the 2 s gap has not passed, and types the line (`agterm.type`: text, pause, Enter).
7. A line that carries a step is reported back as `entry.delivered`, which is what allows the
   agent to close that step.

A tick every 5 s feeds `tick` to every running run (timeouts, reminders); the outbox is also
flushed every second.

## Storage

`~/.local/state/flows/flows.db` (`FLOWS_STATE` overrides), in WAL mode:

| Table | Holds |
|---|---|
| `runs` | One row per run: id, process, number, status, and the engine's whole run state as JSON (iteration, vars, role bindings, per-entry status, attempts, failures, notes, the waking event, delivery and reminder marks). |
| `events` | Every event, with its run and entry, outcome, data, source, and whether it was processed. Past iterations are read back from here. |
| `outbox` | Lines to type: run, role (not session: the session is resolved when the line goes out), text, the step it carries, attempts, when it was sent. |
| `sessions` | The last agterm status seen per session. |

Definitions are never stored: they are read from `$FLOWS_HOME` at start and on every change.

**Restart.** flowd can be stopped at any point. On start it loads plugins and definitions, asks
agterm for its live sessions (a bound session that no longer exists is treated as closed), starts
the plugins, re-arms the watch of every waiting entry, processes any event that was stored but not
processed, and delivers lines still in the outbox.

## Security model

- flowd listens on `127.0.0.1` only and has no authentication.
- Spawned agents usually run with `--dangerously-skip-permissions`, and run variables are pasted
  into their prompts. So anything that can drive flowd can make an agent run code.
- Web pages are kept out: a request with a foreign `Host` (DNS rebinding) or a foreign `Origin`
  (a cross-site request) is refused with 403, and a body that is not `application/json` with 415,
  which forces a CORS preflight that flowd never answers. The UI renders evidence as a link only
  for `http(s)` URLs.
- Local processes running as you are trusted: they could edit your files anyway.

## Design records

The decisions behind this layout are in [specs/2026-10-04-flows-design.md](specs/2026-10-04-flows-design.md)
(the system) and [specs/2026-10-04-open-source-ready-design.md](specs/2026-10-04-open-source-ready-design.md)
(docs, conventions, `flow check`). Their implementation plans are in [plans/](plans/).
