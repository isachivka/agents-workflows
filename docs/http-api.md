# HTTP API

flowd serves JSON on `127.0.0.1:7420` (`FLOWD_PORT` overrides), with no authentication: it is
reachable only from this machine, and the checks below keep web pages out. The web UI and the
`flow` CLI use exactly this API (`src/http.ts`).

## Conventions

- Bodies are JSON objects sent with `content-type: application/json`. Any other content type on
  a `POST` or `PUT` gets **415**: a browser cannot send JSON cross-site without a preflight,
  which flowd never answers.
- A request whose `Host` is not `127.0.0.1` or `localhost` (any port), or whose `Origin` is set
  and is not flowd's own, gets **403**. That stops DNS rebinding and cross-site requests.
- Path ids are URI-encoded: run `pr-loop#3` is `/api/runs/pr-loop%233`.
- Errors: `{"error": "…"}` with **409** (the engine refused, for example `step c is not the
  current step`), **404** (no such run, process or step, or no route), **400** (bad JSON, a malformed request target, missing
  `type`); `{"errors": ["…"]}` with **409** (the definition changed on disk since `mtime`),
  **422** (the definition is invalid) or **404** (deleting a definition that does not exist). An unexpected error gives **500** `{"error": "…"}`.

## Definitions

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/processes` | | `[{name, valid, errors, description, repeat, triggers, roles, entries, openRuns}]`, every file in `processes/` |
| GET | `/api/processes/:name` | | `{name, text, mtime, errors, object}` (`object`: the parsed YAML, or `null`) |
| PUT | `/api/processes/:name` | `{text, mtime}` or `{object, mtime}` | `{mtime}`. `mtime` is the one the edit was based on, `null` for a new file. `object` is re-serialised (comments lost). |
| DELETE | `/api/processes/:name` | `?mtime=` | `{}` |
| GET | `/api/steps` | | `[{id, valid, errors, summary, usedBy}]` |
| GET | `/api/steps/:id` | | `{name, text, mtime, errors, summary, body}` |
| PUT | `/api/steps/:id` | `{text, mtime}` or `{summary, body, mtime}` | `{mtime}` |
| DELETE | `/api/steps/:id` | `?mtime=` | `{}` |
| POST | `/api/steps/:id/preview` | `{body, run?}` | `{text}`: `body` rendered against that run (current entry's event included), or with no data; 409 `{error}` on a render error |

A saved file is validated with the same loader as `flow check`; an invalid one is not written.

## Runs

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/runs` | `?all=1` adds finished runs | `RunSummary[]`, open runs first |
| POST | `/api/runs` | `{process, bind?: {role: session}}` | `{run}` |
| GET | `/api/runs/:id` | | `RunSummary` plus `entries` (per-entry state), `events` (newest first) and `sessions` (`{sessionId: agterm status}`) |
| POST | `/api/runs/:id/pause` · `/resume` · `/stop` | | `{run}` |
| POST | `/api/runs/:id/vars` | `{vars: {k: v}}` | `{run}` |
| POST | `/api/runs/:id/entries/:entry/done` · `/failed` | `{note?, evidence?}` | `{run}`; closes the entry as the human (`failed` needs a note) |
| POST | `/api/runs/:id/entries/:entry/skip` | `{note}` | `{run}`; a skip needs a reason |
| POST | `/api/runs/:id/entries/:entry/retry` · `/goto` | | `{run}` |
| GET | `/api/runs/:id/entries/:entry/prompt` | | `{text}`, what `flow show` prints for that entry |
| POST | `/api/runs/:id/roles/:role/rebind` | `{session}` | `{run}` |
| POST | `/api/runs/:id/roles/:role/respawn` | | `{run}` |

`RunSummary`: `{id, process, iteration, status, reason, current, currentStatus, currentKind,
waitingOn, roles, vars, needsYou, plan}`, where `plan` lists every entry as
`{id, kind, role, detour, waitFor, status}` and `needsYou` is true for a `needs-human` run or one
standing on an open human step.

## Agents and events

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/show` | `?session=` or `?run=&entry=` | `{text}` |
| POST | `/api/report` | `{session?, run?, entry?, outcome: "done"\|"failed", note?, evidence?, human?}` | `{run}`. Without `run` and `entry` the step is found from `session`. `human: true` reports as the human. |
| POST | `/api/vars` | `{session? \| run?, vars}` | `{run}` |
| POST | `/api/events` | `{type, run?, entry?, outcome?, data?}` | `{}` or `{run}`. Without `run` the event is a broadcast. |

## Sessions, plugins, the daemon

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/sessions` | | `[{id, name, cwd, workspace, status?, title?}]` from `agtermctl tree --json` |
| POST | `/api/sessions/:id/focus` | | `{}`; selects that session in agterm |
| GET | `/api/plugins` | | `{core: [core event types], plugins: [{name, source, events, actions, lastError, watches}]}` |
| POST | `/api/restart` | | `{}`, then flowd exits; launchd starts it again |
| GET | `/api/stream` | | Server-sent events: `data: runs` when any run changed, `data: defs` when definitions were reloaded |

## Hook endpoints

Called by `flow agterm-hook` and `flow claude-hook`. Both answer `{}` at once and process the
event afterwards.

| Method | Path | Body |
|---|---|---|
| POST | `/agterm` | `{kind, status, session}`: `kind` `session.closed` closes the session; anything else records `status` (`active`, `completed`, `idle`, `blocked`) |
| POST | `/claude` | `{event: "compacted", session}` |

## Static files

Any other `GET` outside `/api/` serves a file from `ui/` (`/` is `index.html`).
