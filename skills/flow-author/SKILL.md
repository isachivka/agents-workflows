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
2. **Write the steps.** Frontmatter `summary:` (the headline a person reads for the step in the UI: a plain sentence saying who does what, "The dev fixes red CI", not a label), then the prompt. Talk
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
| stop quietly when there is nothing to do | `on_fail: end` — the run is done (or the next iteration starts), nobody is asked |
| skip work a run already did (a PR reviewed once) | in an `sh` step: `flow ls --all --process "$FLOW_PROCESS" --where pr="$u" >/dev/null && continue` — exit 1 means no such run; see the review-queue recipe in docs/processes.md |
| a fix-up branch | `{step: <id>, role: <role>, detour: true, after: {goto: <id>}}` after the main line; reached only by a `goto` |
| start on a schedule or an event | `triggers: [{cron: "0 10 * * 1-5"}]`, `[{on: flow.run.done, where: {process: other}}]` |
| start on a plugin event (GitHub) | `triggers: [{on: gh.opened, with: {label: ready-for-agent}}]`; also `{on: gh.merged, with: {base: main}}`, `{on: gh.ci, with: {branch: main}, where: {conclusion: failure}}`. The run starts with the event's data as vars: `{{vars.pr}}`, `{{vars.number}}`, … |
| a mechanical step without an agent (git, a script) | `{sh: 'git worktree add "$FLOW_VAR_DIR"'}` — run data comes as env `FLOW_VAR_<NAME>`, never `{{…}}` in the command; quote it; hand values back with `flow set --run "$FLOW_RUN" k=v` |
| let time pass (keep a session a day, then clean up) | `{id: tail, wait: 24h}`; survives flowd restarts |
| one shared thing (a test environment) for several runs | `hold: <name>` on each entry that uses it: `{step: deploy, role: dev, hold: desk-1}`, `{step: autotests, role: dev, hold: desk-1}`. One run at a time stands on those entries; others queue in front, the rest runs in parallel. Not `max_runs: 1`, which blocks the whole process |
| one item per pass, forever | `repeat: true` — vars are cleared between iterations |
| put a process's sessions in one named workspace, name them by date | `workspace: Log sync` on the process (free text, may be shared); `name: "sync {{run.date}}"` on a role (default `{{run.id}} {{role}}`) |
| close the agent's terminal at the end | the last step's prompt says: after a successful `flow done`, run `agtermctl workspace delete --target "$AGTERM_WORKSPACE_ID"` (with `max_runs` > 1 or a shared `workspace:`: `agtermctl session close --target "$AGTERM_SESSION_ID"`); on failure leave it open. See the recipe in docs/processes.md |

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
- The run's pull request is always `vars.pr` (see "Standard variables" in docs/processes.md): a
  step that opens or finds a PR should say `flow set pr=<url>`; never name it otherwise.
  Likewise a Slack thread about the work is always `vars.slack_thread` (the UI links it).
- `vars.title` is what the run is about, shown to tell runs apart. flowd fills it from the PR's
  title once `pr` is set; a step before the PR may ask the agent to `flow set title="…"`. Do not
  use `title` for anything else.
- `gh.checks`, `gh.review` and `gh.merged` waits need the PR: `flow set pr=<url>` before the wait
  (a run a gh trigger started already has `vars.pr`), or
  `wait_for: {on: gh.checks, with: {pr: "{{vars.pr}}"}}`. A `gh.merged` wait for any merge in a
  repo names one: `with: {base: main}`.
- A `gh.review` wait without `with: {from: …}` wakes on every comment, bots included: use
  `from: requested` (or logins) to wait for the reviewer. A pure `gh.review` wait (no step) also
  needs `only: decisions`, or a comment closes it as done. See `$REPO/docs/plugins.md`.
- A merged PR ends a `gh.review` wait as `done`, a closed one as `failed` (`{{event.data.kind}}` is
  `merged`/`closed`). An agent step woken by review events should say what to do then: merged →
  `flow done`, closed → `flow failed`.
- `gh.checks` and `gh.review` need a PR, so they cannot be triggers: start on CI with `gh.ci`.
  A trigger that cannot work shows its error under the process (UI) and in Settings → Plugins.
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
- An `sh` entry runs in a login `zsh` as you, no sandbox, in its own `cwd:` (a template) or the
  process `cwd`. Exit 0 is done with the last output line as the note; anything else fails with
  the exit code and stderr, and `on_fail` decides. Besides `FLOW_VAR_<NAME>` it gets `FLOW_RUN`,
  `FLOW_PROCESS`, `FLOW_ITERATION` and `FLOW_EVENT_<KEY>`. It is killed after `timeout` (default
  30 minutes), and a flowd restart mid-command fails it — make commands safe to run again.
- A trigger that fires while the process already has `max_runs` open runs is skipped, not queued.
  For work that must not be lost, start from a list that keeps it (cron + an `sh` step that picks
  the next item, as in the review-queue recipe), not from the event alone.
- Edits reach running runs at their next step. Removing the entry a run stands on stops that run
  for the user.

## New event sources and actions

Write a plugin, not daemon code: a TS file in `$FLOWS_HOME/plugins/` whose default export is
`{name, events, start?, watch?, actions?}`, configured in `plugins.yaml` — see
[docs/plugins.md](../../docs/plugins.md). flowd loads plugins at start: ask the user before
restarting it (UI → Plugins → Restart, or `launchctl kickstart -k gui/$UID/local.flows`).
