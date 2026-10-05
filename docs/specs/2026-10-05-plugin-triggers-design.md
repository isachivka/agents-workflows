# Plugin events as triggers

Status: design agreed 2026-10-05 (user, Claude). Not implemented yet.

## Problem

A process can start on an event (`triggers: [{on: <type>}]`), and routing already matches every
broadcast event against every trigger. But a plugin only learns that someone wants its events
through `watch()`, and flowd calls `watch()` only for a step that is waiting. A trigger on a
plugin event therefore never fires: `triggers: [{on: gh.merged}]` passes `flow check`, is offered
by the UI, and stays silent forever. Today only `flow.*`, `signal.*` and cron can start a process.

The user wants processes started from GitHub: a PR merged in a repo, a PR opened (or labelled)
with a given label, CI failing on a branch.

## Goals

1. A trigger on a plugin event works with no new concept for plugin authors: a trigger is a
   **subscription** exactly like a wait, delivered through the same `watch()`.
2. The `gh` plugin covers the three scenarios: `gh.merged` for a whole repo, a new `gh.opened`,
   and a new `gh.ci` for workflow runs on a branch.
3. A run started by an event knows what started it without extra plumbing.
4. A trigger that cannot work is visible — on the Plugins page and on the process — not silent.

## Non-goals

Webhooks (polling stays); catching events that happened while flowd was down; queueing starts
refused by `max_runs` (they keep recording `flow.trigger.skipped`); static validation of which
plugin events can be triggers.

## Design

### One subscription model

`Watch` gains optional fields and loses two required ones:

```ts
interface Watch {
  type: string;                    // "gh.merged"
  with: Dict;                      // parameters for the plugin
  cwd: string;                     // the process cwd, ~ expanded: where a repo-bound plugin runs
  run?: string; entry?: string;    // set for a waiting step, absent for a trigger subscription
  vars: Record<string, string>;    // the run's vars; {} for a trigger subscription
  processes?: string[];            // trigger subscriptions: which processes asked (for status/UI)
}
```

- **Wait** (unchanged behaviour): a step with `wait_for` → `watch({type, with, cwd, run, entry, vars})`.
  The plugin emits with `run`/`entry` → the event goes to that step only. Emit once, then stop.
- **Trigger**: every `triggers: [{on: <plugin type>, with?, where?}]` → a standing subscription
  `watch({type, with, cwd, vars: {}, processes})` with no `run`. The plugin emits without
  `run`/`entry` → a broadcast → routing matches it against every trigger (with its `where`) and
  every waiting step, as today. A trigger subscription keeps emitting for as long as it lives.
- A plugin tells the two apart by `w.run`. A plugin that cannot serve a subscription throws from
  `watch()` with a message that says what to write instead; the host's existing retry/backoff
  and error reporting apply.

`flow.*` and `signal.*` triggers need no subscription (no plugin), as today; cron is unchanged.

### Subscription lifecycle in flowd

- On every definitions load (`reloadDefs`) flowd computes the wanted trigger subscriptions from
  all valid processes. Identical subscriptions — same `type`, same `with`, same `cwd` — are one
  subscription shared by those processes, so one GitHub merge produces one event, not one per
  interested process.
- Key: `trigger \0 type \0 cwd \0 stable-JSON(with)`. New keys are watched, vanished keys are
  unwatched, unchanged keys are left alone (their plugin state, e.g. gh's baseline, survives an
  unrelated edit). The same "keep unchanged watches" rule the daemon already follows for waits.
- On start they are created right after the first `reloadDefs`; on close they are stopped with
  every other watch.

### Processes

A trigger may carry `with` (plain values, no templates — there is no run yet):

```yaml
triggers:
  - {on: gh.merged, with: {base: main}}
  - {on: gh.opened, with: {label: ready-for-agent}}
  - {on: gh.ci, with: {branch: main}, where: {conclusion: failure}}
```

`with` is validated as a mapping. `where` filters the emitted event's `data` as today.

### A run knows its trigger

When an event trigger starts a run, every scalar field of the event's `data` is copied into the
run's `vars` as a string (`vars.pr`, `vars.number`, `vars.branch`, …), plus `vars.trigger` = the
event type. Steps read them as `{{vars.pr}}`; a later `wait_for: gh.checks` finds `vars.pr` with
no `flow set`. The first entry still gets the event as `{{event.*}}`. `repeat: true` clears vars
between iterations as before.

### gh

PR mode (unchanged): `with.pr` or, for a wait, `vars.pr`. Repo mode: no PR; the repo is
`with.repo` (`owner/name`) or, when absent, the repo of `w.cwd` (gh resolves it from the
directory). Every repo-mode subscription takes its first poll as the **baseline** and emits only
what is new after it — history never fires a trigger. A wait in repo mode emits once and stops;
a trigger subscription keeps emitting.

| Event | Mode | Polls | Emits (data) | Outcome |
|---|---|---|---|---|
| `gh.checks` | PR only | `gh pr checks <pr> --required` (as today) | `pr`, `failed`, `links` | done / failed |
| `gh.merged` | PR, or repo (`with.base?`, `with.label?`) | PR: `gh pr view`; repo: `gh pr list --state merged` | `pr` (url), `number`, `title`, `branch`, `base`, `author` | done (PR mode: failed when closed unmerged) |
| `gh.review` | PR only | `gh pr view --json reviews,comments` (as today) | `reviews`, `comments` | — |
| `gh.opened` (new) | repo (`with.base?`, `with.label?`) | `gh pr list --state open` | same as `gh.merged` repo mode | done |
| `gh.ci` (new) | repo (`with.branch` required, `with.workflow?`) | `gh run list --branch <b> --json …` | `run` (url), `id`, `workflow`, `conclusion`, `branch`, `sha`, `event` | done when `conclusion` is `success`, else failed |

- `gh.opened` with a label fires when an open PR **first appears** with that label — a PR opened
  with it, or an older PR that gets it later.
- `gh.ci` fires once per workflow run when it reaches `status: completed`.
- `gh.checks` or `gh.review` without a PR throws: `gh.checks needs a PR; to start on CI results use gh.ci`.
- Repo mode polls every `interval_ms` (default 60 000) with `--limit 30`; `gh` runs with `cwd: w.cwd`.

### Visibility

- `GET /api/plugins` lists trigger subscriptions next to waits: `{type, processes, error}`.
- `GET /api/processes` gives each process `triggerErrors: string[]` from its subscriptions; the
  Processes page shows them under the process like validation errors.
- The Plugins page shows a subscription row as `trigger · pr-loop, release` instead of a run link.
- The trigger editor gets a `with` field (JSON, like `where`).

## Testing

- Plugin host: a watch without `run` is keyed and stopped by its subscription key; emits from it
  broadcast.
- Daemon: a trigger on a test-plugin event creates one subscription; two processes with the same
  trigger share it; an emitted event starts both processes; an edit that changes `with` replaces
  only that subscription; deleting the trigger unwatches it; an unchanged subscription survives a
  reload untouched; a throwing subscription shows in `/api/plugins` and the process's
  `triggerErrors`; a triggered run gets the event data as `vars`.
- defs: `with` on a trigger is accepted (mapping only).
- gh: repo-mode baseline (no fire on history), new merged PR emits with the documented data,
  `label`/`base` filters, `gh.opened` on a later label, `gh.ci` one emit per completed run with
  the right outcome, a wait in repo mode emits once, a trigger subscription keeps emitting,
  `gh.checks` without PR throws the documented message, `cwd` passed to `gh`.
- Docs: `concepts.md` (subscriptions), `processes.md` (trigger `with`, trigger vars),
  `plugins.md` (`run`-less watches, emitting broadcasts, `cwd`), the gh section, the
  `flow-author` skill's entry table and a recipe per scenario; `test/docs.test.ts` stays green.
- Manual: a throwaway flowd with a process triggered by `gh.merged` on a scratch repo the user
  names, or skipped if there is none — never on a repo without asking.
