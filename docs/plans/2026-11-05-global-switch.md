# Plan: one switch for everything

Spec: [2026-11-05-global-switch-design.md](../specs/2026-11-05-global-switch-design.md).

## Task 1 — the switch in flowd (`src/store.ts`, `src/daemon.ts`, `test/daemon-off.test.ts`)

Failing tests first, in a new `test/daemon-off.test.ts`:

- off pauses a running run as `pausedBy: "off"`, presses Esc and types the stop line into an active agent,
  types nothing into an idle one; a run the person paused keeps `pausedBy` unset;
- while off, a cron start is refused and `flow.trigger.skipped` is stored; a start by hand and a start by an
  event queue; an event for a waiting run stays unprocessed; an agent's `flow done` is kept;
- on resumes the switch's runs, applies the kept events in order, types the carry-on line to an agent whose
  step is still active, starts the queue; a run the person paused stays paused;
- off survives a restart (a new `Flowd` on the same database).

Code:

- store: `settings (key TEXT PRIMARY KEY, value TEXT)`, `setting(key)`, `setSetting(key, value|null)`.
- daemon: `offSince` read at `init`; `turnOff()` / `turnOn()` run in the event chain; `process()` leaves an
  event unprocessed while off when `deferred(e)` (plugin and signal events, core `flow.*` events, an agent's
  or the system's `entry.report` / `entry.wait`); `startRun` treats every process as paused; `startQueued`
  and `hibernate` do nothing while off; `sessionTurn` stops an agent that starts a turn in a run paused
  `by: "off"`; `stopAgent` takes its line.

`npm test`, `npm run typecheck`: green. Commit `feat(daemon): …`.

## Task 2 — HTTP, CLI (`src/http.ts`, `src/cli.ts`, tests)

- `GET /api/switch` → `{off: <ms>|null}`; `POST /api/switch {on: true|false}` → the same; the stream sends
  `switch` when it changes.
- `flow off` / `flow on`: print `flows is off: …` / `flows is on`.
- Tests in `test/http.test.ts` and `test/cli.test.ts`.

## Task 3 — UI (`ui/app.js`, `ui/text.js`, `ui/style.css`)

- A switch in the header: ON/OFF; turning it off asks `confirm()`.
- While off, a red bar under the header with since when, and Turn on.
- A run paused `by: "off"` reads "paused: flows is off" where pause reasons are shown.

## Task 4 — docs

`docs/concepts.md` (a section), `docs/cli.md`, `docs/http-api.md`, `README.md` if it lists commands,
`skills/flow/SKILL.md` (what the agent sees), the CLI help.
