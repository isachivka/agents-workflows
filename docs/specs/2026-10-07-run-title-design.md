# What a run is about — the `title` variable

## Problem

With several runs open, each card leads with the current step's summary. Nothing says which pull
request or task a run is about, though every such run already has a PR whose title says exactly
that.

## Goals

- A standard variable `title`: what the run works on, in words.
- Filled from the PR by itself: when a run's `pr` is set or changes, and every 10 minutes for open
  runs with a `pr`, so a renamed PR renames the run. Written only when it changed.
- Before a PR exists, an agent may set it (`flow set title="…"`); runs a `gh` trigger started
  already have it from the event.

## Non-goals

- How the UI shows it: a separate design task, which builds on `vars.title`.
- Titles for non-GitHub sources (a later plugin implements the same hook).

## Decisions

- **Plugin hook.** `Plugin.title?({vars, cwd}, ctx) → string | undefined`; `gh` runs
  `gh pr view <pr> --json title` in the process `cwd`. The host asks plugins in load order; the
  first non-empty answer wins; a throw becomes the plugin's `lastError` and the title stays.
- **Daemon.** After an applied input changes `vars.pr`, it reads the title in the background;
  a timer (`titleMs`, default 600 000) re-reads all open runs with a `pr`. A new title goes in as
  an ordinary `run.set` from `flowd`. The PR title wins over a hand-set title.
- **No engine change.** `title` is a plain var: cleared with the others between iterations,
  shown in `flow show`, readable as `{{vars.title}}`.

## Testing

gh: the `title` call and no call without `pr`. Daemon: set on `pr`, refreshed by
`refreshTitles()`, kept when the plugin throws.
