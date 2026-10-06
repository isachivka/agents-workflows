---
name: flow-author
description: Use when creating or changing flows definitions — a step, a process, a role, a trigger, a wait on an event, a plugin — or when `flow check` or the flows UI reports a process or step as invalid. Triggers on "make a flow process", "add a step to <process>", "configure flows", "new workflow", "run <process> every morning", "trigger <process> when …", "write a flows plugin", "why is <process> invalid".
---

# flow-author

flows runs processes built from steps across agterm sessions. Definitions are plain files;
flowd picks up every save by itself. This skill is the working procedure; the full reference is
[docs/processes.md](../../docs/processes.md) (every key) and [docs/plugins.md](../../docs/plugins.md).
From the installed copy of this skill, the repo is
`REPO=$(cd "$(dirname "$(readlink -f "$(command -v flow)")")/.." && pwd)` — read `$REPO/docs/processes.md`.

## Where things live

`$FLOWS_HOME` (default `~/.config/flows`): `steps/<id>.md`, `processes/<name>.yaml`,
`plugins/<name>.ts`, `plugins.yaml`. Ids and names: lowercase letters, digits, dashes.

## Procedure

1. **Look first.** `ls $FLOWS_HOME/steps $FLOWS_HOME/processes`; read the process you are changing.
   Reuse a step whose prompt already fits.
2. **Write the steps.** Frontmatter `summary:` (one line, shown in the UI), then the prompt. Talk
   to the agent directly, say what "done" means, and end with how to report:
   `flow done --note "…"`, or `flow failed --note "…"`. A value a later step needs: tell the agent
   to `flow set key=value`, and read it later as `{{vars.key}}`.
3. **Write the process.** `description`, `cwd`, `roles` (each a `spawn` command — it runs in a login
   shell without your aliases, so write `--dangerously-skip-permissions` yourself if you want it),
   then `steps` in order.
4. **Check.** `flow check <name>` and fix every line it prints; then `flow check` with no name.
5. **Try it.** `flow start <name>` and watch http://127.0.0.1:7420. Ask the user first if the run
   would spawn agents that change real code.

## Choosing an entry

| You want | Write |
|---|---|
| an agent does work | `{step: <id>, role: <role>}` |
| the user does or approves something | `{step: <id>, role: human}` (closed from the UI or `flow done --human`) |
| a fresh context before a step | `{do: clear, role: <role>}`; `compact` keeps a summary |
| wait for CI, a merge, a signal | `{wait_for: gh.checks}` alone — the event's outcome closes it |
| an agent reacts to an event | `{step: <id>, role: <role>, wait_for: gh.checks}`; the prompt reads `{{event.outcome}}`, `{{event.data.<key>}}` |
| retry, or loop back on failure | `on_fail: retry` or `on_fail: {goto: <id>}`; `retries` caps failures per iteration (default 3) |
| a fix-up branch | `{step: <id>, role: <role>, detour: true, after: {goto: <id>}}` after the main line; reached only by a `goto` |
| start on a schedule or an event | `triggers: [{cron: "0 10 * * 1-5"}]`, `[{on: flow.run.done, where: {process: other}}]` |
| start on a plugin event (GitHub) | `triggers: [{on: gh.opened, with: {label: ready-for-agent}}]`; also `{on: gh.merged, with: {base: main}}`, `{on: gh.ci, with: {branch: main}, where: {conclusion: failure}}`. The run starts with the event's data as vars: `{{vars.pr}}`, `{{vars.number}}`, … |
| one item per pass, forever | `repeat: true` — vars are cleared between iterations |

## Traps

- Two entries with the same `step` or `do` need explicit ids: `{id: clear-lead, do: clear, role: lead}`.
- `{{event.*}}` exists only in an entry an event woke: an agent step with its own `wait_for` (a
  human step's event closes it, so its prompt has none), or the first entry of a run an `on:`
  trigger started, in its first iteration (not with `repeat: true`). A detour reached by `goto`
  has no event — have the agent read the state (`gh pr checks {{vars.pr}}`) instead.
  `flow check` reports this.
- A missing `{{vars.x}}` stops the run for the user rather than sending a broken prompt: an earlier
  step of the same iteration must `flow set` it.
- Ad-hoc events need the `signal.` prefix in definitions (`wait_for: signal.deploy-done`);
  `flow signal deploy-done` adds it when sending.
- A plugin's event types are `<plugin>.<event>`; an unknown type fails `flow check`.
- `human` is a reserved role; agent roles must be declared under `roles`.
- `gh.checks`, `gh.review` and `gh.merged` waits need the PR: `flow set pr=<url>` before the wait
  (a run a gh trigger started already has `vars.pr`), or
  `wait_for: {on: gh.checks, with: {pr: "{{vars.pr}}"}}`. A `gh.merged` wait for any merge in a
  repo names one: `with: {base: main}`.
- `gh.checks` and `gh.review` need a PR, so they cannot be triggers: start on CI with `gh.ci`.
  A trigger that cannot work shows its error under the process (UI) and on the Plugins page.
- A trigger's `with` takes plain values, no templates: there is no run yet. A trigger watches a
  repo, never one PR (`with.pr` is refused).
- PR titles, branches and authors come from whoever opened the PR: on a repo outsiders can open
  PRs in, gate `gh.opened` with a label and do not let a prompt obey `{{vars.title}}`.
- Plugin triggers fire only on what happens after flowd started watching: history, and anything
  that happened while flowd was down, never fires.
- A step that makes the agent wait (a background job, the user in a viewer) must tell it to run
  `flow wait --note "<what>"` (`--human` when the user acts) before ending its turn; otherwise
  flowd reminds it and stops the run after the third silent turn end. A waiting step still has
  its `timeout`.
- Edits reach running runs at their next step. Removing the entry a run stands on stops that run
  for the user.

## New event sources and actions

Write a plugin, not daemon code: a TS file in `$FLOWS_HOME/plugins/` whose default export is
`{name, events, start?, watch?, actions?}`, configured in `plugins.yaml` — see
[docs/plugins.md](../../docs/plugins.md). flowd loads plugins at start: ask the user before
restarting it (UI → Plugins → Restart, or `launchctl kickstart -k gui/$UID/local.flows`).
