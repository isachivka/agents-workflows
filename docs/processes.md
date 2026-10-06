# Steps and processes reference

Every key of a step file and a process file, how a run moves through them, and what the
validator checks. The ideas behind them are in [concepts.md](concepts.md).

## Files

Definitions live in `$FLOWS_HOME` (default `~/.config/flows`; the `FLOWS_HOME` environment
variable overrides it). It may be a git repository.

```
$FLOWS_HOME/
  steps/<id>.md            a reusable step
  processes/<name>.yaml    a process
  plugins/<name>.ts        your plugins (see plugins.md)
  plugins.yaml             plugin configuration, one mapping per plugin name
```

Step ids and process names match `^[a-z0-9][a-z0-9-]*$`: lowercase letters, digits and dashes,
not starting with a dash. flowd notices saved files by itself (within about 300 ms) and the UI
updates.

## Step files

```markdown
---
summary: The lead reviews the dev's commits
---
Review the new commits in {{vars.worktree}} against "{{vars.task}}". Run the tests yourself.
Something to fix: `flow failed --note "<what to fix>"`. Good: `flow done --note "<verdict>"`.
```

- `summary` (required, the only frontmatter key): the headline a person reads for that step in the UI. Write it as a plain sentence saying who does what ("The dev fixes red CI"), not a label.
- The body is the prompt an agent reads with `flow show`. It must not be empty.

Placeholders, substituted when the step starts (`src/template.ts`, `renderData` in `src/engine.ts`):

| Placeholder | Value |
|---|---|
| `{{run.id}}` | `pr-loop#3` |
| `{{run.process}}` | `pr-loop` |
| `{{run.iteration}}` | `2` |
| `{{vars.<key>}}` | a run variable set with `flow set key=value` |
| `{{event.type}}` | the type of the event that woke this entry |
| `{{event.outcome}}` | `done` or `failed`, if the event had one |
| `{{event.data.<key>}}` | a field of that event's data |

There is no logic, only substitution. An object renders as JSON. A missing value is an error: the
step does not start and the run goes `needs-human` with `{{vars.x}} has no value`. Only an entry
that an event woke has `{{event.*}}`: an agent step or action with its own `wait_for`, or the first
entry of a run that an `on:` trigger started, in its first iteration. A human step's event closes
it, so its prompt never has one.
The validator rejects `{{event.*}}` in any other step body or `text` (also on the first entry
when the process repeats). It does not check `with`, where `{{event.*}}` never works. A manual or
cron start of a triggered process, or a `goto` back to its first entry, has no event either: the
step then stops the run with a render error.

## Standard variables

Names every process and agent uses the same way, so the UI and plugins can rely on them.

| Name | Holds | Read by |
|---|---|---|
| `pr` | the URL of the run's pull request (GitHub) or merge request | the UI's "Open the PR" button on every run card and the run page; `gh.checks`, `gh.merged`, `gh.review` waits (as their default PR); a run started by a `gh` trigger gets it automatically |

Agents set `pr` the moment the work has a PR (`flow set pr=<url>`), whether or not the step asks;
the `flow` skill tells them so, and `flow set` hints when a PR URL goes under another name. When a
run has no `pr`, the UI falls back to the first variable holding a PR-shaped URL (`…/pull/<n>`,
`…/merge_requests/<n>`), never to any other link.

## Process keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `description` | string | required | One line, shown in the UI. |
| `cwd` | string | required | Working directory of spawned agents. `~` is expanded. |
| `repeat` | boolean | `false` | Start a new iteration after the last entry instead of finishing. |
| `max_runs` | integer ≥ 1 | `1` | Open runs allowed at once. Further starts are refused. |
| `triggers` | list | none | Automatic starts, see below. Manual starts always work. |
| `roles` | mapping | none | Agent roles, see below. |
| `steps` | list | required | The entries, in order. Must not be empty. |

## Roles

```yaml
roles:
  lead: {spawn: "claude --dangerously-skip-permissions"}
  dev:  {spawn: "claude --model sonnet", cwd: "{{vars.worktree}}"}
```

| Key | Meaning |
|---|---|
| `spawn` | Required. The command that starts the agent. It runs as `/bin/zsh -lc '<spawn> <first line>'`: a login shell, so `claude` is on `PATH`, but your `.zshrc` aliases are not loaded. Write `--dangerously-skip-permissions` yourself if you want it. |
| `cwd` | Optional template, rendered when the role is spawned. Defaults to the process `cwd`. |

`human` is reserved: entries with `role: human` need no declaration.

## Triggers

```yaml
triggers:
  - {cron: "0 9 * * 1-5"}
  - {on: flow.run.done, where: {process: ci-loop}}
  - {on: gh.merged, with: {base: main}}
```

| Key | Meaning |
|---|---|
| `cron` | A cron expression in [croner](https://github.com/hexagon/croner) syntax (5 fields; a leading seconds field is accepted). |
| `on` | An event type. The run's first entry gets the event as `{{event.*}}` (first iteration only). |
| `with` | With `on` and a plugin event: parameters for the plugin's subscription, plain values (no templates: there is no run yet). For `gh`: `repo`, `base`, `label`, `branch`, `workflow` (see [plugins.md](plugins.md#worked-example-gh)). |
| `where` | With `on`: a mapping that must be a subset of the event's data. |

A run an `on:` trigger started begins with the event in its vars: each scalar field of the
event's `data` as a string, plus `trigger` (the event type). After a `gh.merged` trigger that is
`{{vars.pr}}` (the PR's URL), `{{vars.number}}`, `{{vars.title}}`, `{{vars.branch}}`,
`{{vars.base}}`, `{{vars.author}}` and `{{vars.trigger}}`. With `repeat: true` they are gone
from the second iteration on, like every var.

PR titles, branches and authors are written by whoever opened the PR. On a repository outsiders
can open PRs in, gate `gh.opened` with a label only maintainers can set, and treat
`{{vars.title}}`, `{{vars.branch}}` and `{{vars.author}}` in a prompt as untrusted text: an agent
started with `--dangerously-skip-permissions` acts on what its prompt says.

## Entries

Each item of `steps:` is one of these kinds:

| Kind | Write | What happens |
|---|---|---|
| agent step | `{step: <id>, role: <role>}` | The role's session gets the nudge line; the agent reports with `flow done` / `flow failed`. |
| human step | `{step: <id>, role: human}` | Shown in the UI under "Waiting for you"; closed there or with `flow done --human`. |
| session action | `{do: clear, role: <role>}`, `{do: compact, role: <role>}` | flowd types `/clear` or `/compact` into the role's session. |
| typed line | `{do: type, role: <role>, text: "..."}` | flowd types a literal line (a template) into the role's session. |
| plugin action | `{do: <plugin>.<action>, with: {...}}` | flowd calls the plugin; a throw fails the entry. No action ships with flows yet. |
| pure wait | `{wait_for: <type>}` | Waits for an event; its `outcome` closes the entry (`failed` fails it). |
| shell command | `{sh: 'git worktree add "$FLOW_VAR_DIR"'}` | flowd runs the command itself (a login `zsh`) in the entry's `cwd`, else the process `cwd`. Exit 0 is done (note: the last line of output), anything else fails (note: the exit code and stderr). The command is never templated: the run reaches it as environment variables `FLOW_RUN`, `FLOW_PROCESS`, `FLOW_ITERATION`, `FLOW_VAR_<NAME>`, `FLOW_EVENT_<KEY>` (upper-cased, other characters `_`), so an outside value cannot run as code. It hands values on with `flow set --run "$FLOW_RUN" key=value`. Killed after the entry's `timeout`, else 30 minutes. A flowd restart mid-command fails the entry. It runs as you, without a sandbox. |
| pause | `{wait: 24h}` | Waits that long, then is done and the run moves on. The clock is kept in the database, so a flowd restart does not reset it. A human can end it early (`done`, `skip`) or restart it (`retry`). |

Keys on any entry:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | the `step`, else the `do`, else the `wait_for` type, else `wait`, else `sh` | Unique in the process; `goto` targets it. Two entries with the same step or action need explicit ids. |
| `step` | string | | A step id (a file in `steps/`). |
| `role` | string | | A declared role, or `human`. |
| `do` | string | | `clear`, `compact`, `type`, or `<plugin>.<action>`. |
| `text` | string | | The line for `do: type`. |
| `with` | mapping | `{}` | Arguments for a plugin action. String values are templates over `run` and `vars` (no `{{event.*}}`). |
| `wait_for` | string or mapping | | An event type, or `{on: <type>, where: {...}, with: {...}}`. On an agent step or an action it waits, then the step starts. On a human step the event closes it (`failed` fails it), and a human can close it first. Alone it is the entry's whole job. `with` (templates over `run` and `vars`) goes to the plugin's watch, for example `{pr: "{{vars.pr}}"}`. |
| `on_fail` | `human`, `retry`, `end` or `{goto: <id>}` | `human` | What a failure does: stop for a human, run the entry again, end the iteration quietly ("nothing to do"), or jump. |
| `retries` | integer ≥ 0 | `3` | Failures of this entry allowed per iteration. One more stops the run for a human, whatever `on_fail` says (except `end`, which never counts). |
| `after` | `{goto: <id>}` | | When the entry is done, jump there instead of advancing. |
| `detour` | boolean | `false` | Normal advancing skips this entry; only a `goto` reaches it. A detour needs `after`. |
| `sh` | string | | A shell command flowd runs (see the kinds above). Only on its own (no `step`, `do`, `wait`, `role`); a `wait_for` before it is allowed. |
| `cwd` | string | the process `cwd` | For `sh` only: where the command runs. A template over `run` and `vars`. |
| `wait` | duration | | A pause: `30s`, `10m`, `2h`, `1d`. Only on its own (no `step`, `do`, `wait_for`). |
| `timeout` | duration | none | `30s`, `10m`, `2h`, `1d`. An entry `active` or `waiting` longer than this fails. |

## How a run moves

From `src/engine.ts`:

- **Advance.** When an entry is done, the run goes to the next entry that is not a detour, or to
  `after.goto`. Past the last entry the iteration ends.
- **Fail.** `on_fail` applies. `end` ends the iteration as if past the last entry: the run is
  `done`, or with `repeat` the next iteration starts; nobody is asked. `retry` enters the entry again. `{goto: X}` resets X and every
  entry from X through the failed one to `pending` (for a forward goto, X only), keeping their
  attempt and failure counts, then enters X. More than `retries` failures of one entry in an
  iteration stops the run.
- **Iteration end.** Without `repeat` the run is `done` and emits `flow.run.done`. With
  `repeat: true` it emits `flow.iteration.done`, bumps the iteration, resets every entry and
  clears the vars. What a process must remember between iterations belongs in its project's
  files. A repeating iteration that finishes without waiting for anything (for example only a
  `clear` on a role with no session) stops the run instead of looping.
- **Human overrides**: mark the current entry done or failed (UI, or `flow done|failed --human`),
  skip it (a skip needs a reason), retry it, or go to any entry (UI or HTTP API).
- **Back on track by talking to the agent.** An agent step that failed and stopped the run stays
  the agent's: tell the agent in its session how to go on, and once it is done its own
  `flow done` resumes the run at the next entry.

## Validation

`flow check`, flowd and the UI's save all use the same loader (`src/defs.ts`). An invalid
process is listed with its errors and cannot start; other processes are unaffected. Messages
name the entry as `steps[N]` (counting from 1) or by id:

| Rule | Message |
|---|---|
| step id, process name | `step id X must match …`, `process name X must match …` |
| step frontmatter | `missing --- frontmatter --- block`, `frontmatter must be a mapping`, `unknown key X`, `summary is required`, `body is empty` |
| YAML | `yaml: …`, `a process file must be a YAML mapping` |
| process keys | `unknown key X`, `description is required`, `cwd is required`, `repeat must be true or false`, `max_runs must be an integer >= 1` |
| roles | `roles must be a mapping`, `role name human is reserved`, `role X: spawn is required`, `role X: cwd must be a string`, `role X: unknown key Y` |
| triggers | `triggers must be a list`, `trigger N: needs cron or on`, `trigger N: cron …: <parse error>`, `trigger N: unknown event type X`, `trigger N: where must be a mapping`, `trigger N: with must be a mapping`, `trigger N: with only applies to on: triggers` |
| entry shape | `steps must be a non-empty list`, `steps[N]: must be a mapping`, `steps[N]: unknown key X`, `steps[N]: needs step, do, wait_for, wait or sh`, `steps[N]: wait is a pause on its own; it cannot go with step, do or wait_for`, `steps[N]: sh must be a command`, `steps[N]: sh runs on its own; it cannot go with step, do, wait or role`, `steps[N]: cwd on a step is only for sh, and must be a path`, `steps[N]: step and do are exclusive` |
| steps and roles | `steps[N]: steps/X.md is missing or invalid`, `steps[N]: step needs a role`, `steps[N]: undeclared role X` |
| actions | `steps[N]: do: clear needs a declared agent role`, `steps[N]: do: type needs text`, `steps[N]: unknown action X` |
| events | `steps[N]: unknown event type X`, `steps[N]: wait_for must be an event type or {on, where, with}`, `steps[N]: wait_for.where must be a mapping`, `steps[N]: wait_for.with must be a mapping`, `X: step Y uses {{event.*}}, but only an agent step or action with wait_for (or the first entry of a non-repeating run an on: trigger started) gets an event` |
| failure handling | `steps[N]: with must be a mapping`, `steps[N]: on_fail must be retry, human, end or {goto: id}`, `steps[N]: retries must be an integer >= 0`, `steps[N]: after must be {goto: id}`, `steps[N]: bad duration …` |
| detours and ids | `steps[N]: detour must be true or false`, `steps[N]: a detour needs after.goto`, `at least one entry must not be a detour`, `duplicate entry id X (give one an explicit id)`, `X: goto target Y does not exist` |

An event type is known when a loaded plugin declares it (`gh.checks`), when it is a core
`flow.*` event, or when it starts with `signal.`.

## Editing live

- Edits apply to open runs from their next entry. An entry that is waiting picks up an edited
  `wait_for` at once. If the entry a run stands on was removed, the run goes `needs-human` with
  `entry X no longer exists`.
- A role added by an edit can be used by open runs.
- The UI's process form re-serialises the YAML and loses comments. Its YAML tab saves the text
  as written. A save based on an older copy of the file is refused (`the file changed on disk`).

## Recipes

Each of these passes `flow check` (with step files of the same names).

**CI loop with a fix-up detour.** The agent sets `vars.pr` in `open-pr`; red CI goes to the
detour, which jumps back to the wait.

```yaml
description: Open a PR, wait for CI, fix it until green
cwd: ~/code/my-repo
roles:
  dev: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {step: implement, role: dev}
  - {step: open-pr, role: dev}          # the agent runs `flow set pr=<url>`
  - {id: ci, wait_for: gh.checks, on_fail: {goto: fix-ci}}
  - {step: fix-ci, role: dev, detour: true, after: {goto: ci}}
```

**Review loop.** The reviewer's `flow failed` sends the work back to the writer, up to five times.

```yaml
description: A writer and a reviewer, back and forth until the review passes
cwd: ~/code/my-repo
roles:
  writer: {spawn: "claude --dangerously-skip-permissions"}
  reviewer: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {step: write-code, role: writer}
  - {step: review-code, role: reviewer, on_fail: {goto: write-code}, retries: 5}
```

**Every weekday morning.**

```yaml
description: A report every weekday morning
cwd: ~/code/my-repo
triggers:
  - {cron: "0 9 * * 1-5"}
roles:
  reporter: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {do: clear, role: reporter}
  - {step: morning-report, role: reporter, timeout: 30m}
```

**Chaining processes, with a human gate.** Starts when a `ci-loop` run finishes; a human approves
before the agent acts.

```yaml
description: Cut a release after ci-loop finishes, once a human approves
cwd: ~/code/my-repo
triggers:
  - {on: flow.run.done, where: {process: ci-loop}}
roles:
  dev: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {step: approve-release, role: human}
  - {step: cut-release, role: dev}
```

**Release notes for every PR merged into main.** One run per merge; three may be open at once.

```yaml
description: Release notes for every PR merged into main
cwd: ~/code/my-repo
triggers:
  - {on: gh.merged, with: {base: main}}
roles:
  writer: {spawn: "claude --dangerously-skip-permissions"}
max_runs: 3
steps:
  - {step: release-notes, role: writer}   # the prompt reads {{vars.pr}}, {{vars.title}}
  - {step: approve-notes, role: human}
```

**An agent picks up every PR labelled `ready-for-agent`.** The trigger fills `vars.pr`, so the CI
wait needs no `flow set`.

```yaml
description: An agent picks up every PR labelled ready-for-agent
cwd: ~/code/my-repo
triggers:
  - {on: gh.opened, with: {label: ready-for-agent}}
roles:
  dev: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {step: pick-up-pr, role: dev}
  - {id: ci, wait_for: gh.checks}
```

**Wait for the requested reviewer.** The agent answers each review and, when it has pushed its
fixes, runs `flow failed --note "waiting for re-review"` to wait again; bots, the PR's author and
other people's comments never wake it. It finishes with `flow done` when the event it was woken
by is an approval (`{{event.data.state}}` is `APPROVED`). `already: true` catches a review that
lands between the agent's push and its `flow failed`, without firing again on the one it answered.

```yaml
description: Address the requested reviewer's feedback until they approve
cwd: ~/code/my-repo
roles:
  dev: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {step: open-pr, role: dev}            # the agent runs `flow set pr=<url>`
  - {step: address-review, role: dev, wait_for: {on: gh.review, with: {from: requested, already: true}}, on_fail: retry, retries: 10}
  - {step: merge-pr, role: human}
```

The same with a pure wait on the decision: an approval moves on, requested changes go to a fix
detour and back. `already: true` also catches an approval that came before the wait armed, and
never fires twice on the same review.

```yaml
description: Wait for the requested reviewer's decision; fix and wait again on requested changes
cwd: ~/code/my-repo
roles:
  dev: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {step: open-pr, role: dev}
  - {id: approval, wait_for: {on: gh.review, with: {from: requested, only: decisions, already: true}}, on_fail: {goto: fix-review}, retries: 10}
  - {step: merge-pr, role: human}
  - {step: fix-review, role: dev, detour: true, after: {goto: approval}}
```

**Fix main when its CI fails.** `where` keeps only failed runs.

```yaml
description: Fix main when its CI fails
cwd: ~/code/my-repo
triggers:
  - {on: gh.ci, with: {branch: main}, where: {conclusion: failure}}
roles:
  dev: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {step: fix-main, role: dev}         # the prompt reads {{vars.run}}, {{vars.sha}}
```

**Keep the session for a day after the merge, then clean up.** A pause survives flowd restarts.

```yaml
steps:
  - {step: review, role: reviewer}
  - {id: merged, wait_for: gh.merged}
  - {id: tail, wait: 24h}                # late findings still reach the reviewer's session
  - {step: reap, role: reviewer}         # git worktree remove, then close the terminal
```

**Mechanical steps without an agent.** Shell entries prepare and clean up; values go back with
`flow set`. Quote every variable: it may hold anything.

```yaml
steps:
  - {id: worktree, sh: 'git -C ~/code/repo worktree add "$HOME/wt/pr-$FLOW_VAR_NUMBER" "$FLOW_VAR_BRANCH" && flow set --run "$FLOW_RUN" dir="$HOME/wt/pr-$FLOW_VAR_NUMBER"'}
  - {step: review, role: reviewer}
  - {id: tail, wait: 24h}
  - {id: cleanup, sh: 'git -C ~/code/repo worktree remove --force "$FLOW_VAR_DIR"', on_fail: retry, retries: 2}
```

**A review queue: one pull request at a time, each reviewed once.** GitHub's list of review
requests is the queue; a cron run takes the next PR no run has had yet. While a run is open
`max_runs` skips the tick and the PR waits for the next one, so nothing is lost. When there is
nothing new, `on_fail: end` finishes the run without asking anyone.

```yaml
description: Review the pull requests I am asked to review, one at a time
cwd: ~/code/my-repo
max_runs: 1
triggers: [{cron: "*/10 * * * *"}]
roles:
  reviewer: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - id: pick
    sh: |
      for u in $(gh search prs --review-requested=@me --state=open --json url -q '.[].url'); do
        flow ls --all --process "$FLOW_PROCESS" --where pr="$u" >/dev/null && continue
        flow set --run "$FLOW_RUN" pr="$u"; exit 0
      done
      exit 1
    on_fail: end
  - {step: review, role: reviewer}       # the prompt reads {{vars.pr}}
```

One run per PR, not `repeat: true`: vars are cleared between iterations, so a repeating run
would forget which PRs it had.

**Close the agent's terminal when the work is done.** Closing is just the last thing a step
tells the agent to do, after it reports. Each role is spawned into a workspace named after the
process, so when the process runs one run at a time the workspace can go entirely:

```yaml
description: Rescan the docs and push them, then clean up
cwd: ~/code/my-repo
roles:
  writer: {spawn: "claude --dangerously-skip-permissions"}
steps:
  - {step: rescan, role: writer}
  - {step: push-and-close, role: writer}
```

```markdown
---
summary: Push the docs, then close this terminal
---
Push the commit. Pushed: `flow done --note "<sha>"`. Could not push: `flow failed --note "<the
error>"` and leave the session open, so a person can see what happened.

After a successful `flow done`, run as your very last command:
`agtermctl workspace delete --target "$AGTERM_WORKSPACE_ID"`
```

The run is over by then, so flowd takes the closed session calmly. With `max_runs` above 1 several
runs share the workspace: close only your own session instead,
`agtermctl session close --target "$AGTERM_SESSION_ID"`.

The shipped examples are in [`examples/`](../examples/): `demo` (an agent step, compact, clear, a signal wait
and a human step, for a first run), `pr-loop` (two roles, CI, a human merge, a detour) and
`merged-followup` (started by a merge into main).
