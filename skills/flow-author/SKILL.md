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
2. **Write the steps.** Frontmatter `summary:` (the headline a person reads for the step in the UI: a plain sentence saying who does what, "The dev fixes red CI", not a label), and `skills: [deliver, aqa]` when the step relies on skills (never only `/deliver` in the prompt: inside `flow show`'s output the agent may not load it), then the prompt. Talk
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
| bring back a run that ended (the person changed their mind) | `flow reopen <run> --at <entry>` (an `sh` step can call it): vars kept, its agents resume their own conversations at the run's next line to them |
| retry, or loop back on failure | `on_fail: retry` or `on_fail: {goto: <id>}`; `retries` caps failures per iteration (default 3) |
| stop quietly when there is nothing to do | `on_fail: end` — the run is done (or the next iteration starts), nobody is asked |
| skip work a run already did (a PR reviewed once) | in an `sh` step: `flow ls --all --process "$FLOW_PROCESS" --where pr="$u" >/dev/null && continue` — exit 1 means no such run; see the review-queue recipe in docs/processes.md |
| a fix-up branch | `{step: <id>, role: <role>, detour: true, after: {goto: <id>}}` after the main line; reached only by a `goto` |
| start by hand with inputs the first step needs | `flow start <name> --var key=value …` — vars exist before the first prompt and role `name:` render; `flow set` after the start is too late |
| start on a schedule or an event | `triggers: [{cron: "0 10 * * 1-5"}]`, `[{on: flow.run.done, where: {process: other}}]` |
| start on a plugin event (GitHub) | `triggers: [{on: gh.opened, with: {label: ready-for-agent}}]`; also `{on: gh.merged, with: {base: main}}`, `{on: gh.ci, with: {branch: main}, where: {conclusion: failure}}`. The run starts with the event's data as vars: `{{vars.pr}}`, `{{vars.number}}`, … |
| a mechanical step without an agent (git, a script) | `{sh: 'git worktree add "$FLOW_VAR_DIR"'}` — run data comes as env `FLOW_VAR_<NAME>`, never `{{…}}` in the command; quote it; hand values back with `flow set --run "$FLOW_RUN" k=v` |
| let time pass (keep a session a day, then clean up) | `{id: tail, wait: 24h}`; survives flowd restarts |
| another process in the middle, chosen per run (an issue-tracker wrapper around any PR process) | `{inner: true, role: dev}` where it goes; start with `flow start tracker --inner pr --bind dev=…` (`--inner` repeats, outer to inner; `none` skips), or start `pr` on that agent once the run waits on `inner`. The nested run gets a copy of the vars and hands back what it set. A later step learns what ran inside with `flow ls --all \| grep "↳ {{run.id}}$"`. See "Nested runs" in docs/processes.md |
| a value that may be missing (an override given only sometimes, `--var final=…`) | not `{{vars.final}}`: a missing var stops the run. Tell the agent to look for it among `flow show`'s vars and say what to do without it |
| one shared thing (a test environment) for several runs | `hold: <name>` on each entry that uses it: `{step: deploy, role: dev, hold: desk-1}`, `{step: autotests, role: dev, hold: desk-1}`. One run at a time stands on those entries; others queue in front, the rest runs in parallel. Not `max_runs: 1`, which blocks the whole process |
| one item per pass, forever | `repeat: true` — vars are cleared between iterations |
| put a process's sessions in one named workspace, name them by date | `workspace: Log sync` on the process (free text, may be shared); `name: "sync {{run.date}}"` on a role (default `{{run.id}} {{role}}`) |
| two agents side by side in one agterm session (Claude left, Codex right) | `roles: {lead: {spawn: claude …}, peer: {spawn: codex …, beside: lead}}`; `peer` runs in `lead`'s split pane. A step can have them talk: `skills: [bos:peer-chat]` on the lead's step |
| a Codex agent instead of Claude | `spawn: codex --dangerously-bypass-approvals-and-sandbox` on the role; it gets `$flow` and the step's skills as `$name`, its trust question answered. No `do: compact` for it, and it needs `terminal: agterm` |
| cap how many runs work at once, not how many wait (a factory waiting on reviews) | `max_working: 4` on the process: a run parked on a wait, a hold or the person does not count; `max_runs` alone counts every open run |
| close idle agents of runs that wait for hours (a factory), resume them when needed | `hibernate: 30m` on the process: a parked run's idle Claude/Codex is closed, and its next line resumes the same conversation in a new session; an agent in `flow wait --human` or a run that needs the person keeps its terminal |
| a fresh agent sometimes loses its session to something else (a factory) | `respawn_lost: true` on the process: lost in the first 10 minutes of a step, before reporting, it is started again once |
| stop a process's agents when an outside switch goes off, go on when it is back | `pause_on: {on: <plugin>.<event>, where: {…}}` on the process: matching events pause its runs (Esc to agents mid-turn), others resume them |
| keep a process's agents out of the window the person works in | `window: Reels` on the process: its roles spawn into the agterm window of that name, made minimized when there is none |
| no messenger notices for a process (many small runs) | `notify: false` on the process: nothing goes to the messenger, an agent's `flow say` included |
| a name a person reads (the UI, the Telegram topic) | `label: Frontend errors, daily` on the process; a run is then called `<title> · <label>`, or `<label> · 20.10 06:00` without a title |
| run the agents headless, without agterm | `terminal: zmx` on the process: each role runs in a zmx session `flows-<process>-<n>-<role>-<k>` (`workspace:` and a role's `name:` do not apply); the run's terminal button attaches it in agterm. Turn tracking needs `flow install`'s Claude hooks. The agent keeps running after the run ends unless the last step has it run `zmx kill "${FLOW_SESSION#zmx:}"` (docs/processes.md) |
| the person decides on something an agent wrote (a plan, a report) | the prompt says: `flow say "<what you need from them>" --file <abs path>.html`, then `flow wait --human --note "…"` and end the turn; their answer arrives in the session. See "Talking to the person" below |
| tell the person a step is done, in your words | `notify: {done: true, done_text: "…{{note}}"}` in the step file's frontmatter or on the entry |
| no "waits for you" for one step, or no "is done" for a process | `notify: {waits: false}` on the step or entry; `notify: {end: false}` on the process |
| tell the person the result of a mechanical step | in the `sh`: `r=$(./do-it) && echo "$r" && flow say --run "$FLOW_RUN" "Done: $r"` |
| close the agent's terminal at the end | the last step's prompt says: after a successful `flow done`, run `agtermctl workspace delete --target "$AGTERM_WORKSPACE_ID"` (with `max_runs` > 1 or a shared `workspace:`: `agtermctl session close --target "$AGTERM_SESSION_ID"`); on failure leave it open. See the recipe in docs/processes.md |

## Traps

- A start on an agent another run uses is accepted only while that run stands on `inner`;
  anywhere else it is refused. A nested process may not `do: clear` the borrowed role (use
  `compact`), and a `repeat: true` process cannot run nested.

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
  Likewise a Slack thread about the work is always `vars.slack_thread` (the UI links it), and a
  tracker issue is `vars.issue` (its key) with `vars.issue_url` (its page, linked by the UI).
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
  `FLOW_PROCESS`, `FLOW_ITERATION` and `FLOW_EVENT_<KEY>`. It is killed, with everything it started, after `timeout` (default
  30 minutes), and a flowd restart mid-command fails it — make commands safe to run again.
- `max_runs` is how many runs work at once. A start by hand or by an event beyond it waits in line
  (`queued`) and starts by itself; a cron start is skipped. Keep the limit where people can keep up
  with what the runs produce (reviews), not where the machine can.
- A run does one entry at a time: two roles never work at once in one run, even side by side
  (`beside`). Parallel work is two runs, or one agent handing work to the other (a peer chat while
  its step waits with `flow wait`).
- `skills:` names must be skills the role's agent can load where it works: the project's
  `.claude/skills` (`.agents/skills` for Codex), the user's, or a plugin's (`plugin:skill`). A
  skill in a parent folder of the role's `cwd` is not one; point the prompt at its file instead.
- A step whose agent talks to another (peer chat) ends each turn waiting for the answer with
  `flow wait --note "…"`; the answer arrives as a new turn.
- Edits reach running runs at their next step. Removing the entry a run stands on stops that run
  for the user. An edit with an error is not taken: open runs keep the last good version, new starts
  are refused until `flow check` passes. Quote a YAML value with a colon in it (`label: "A: b"`).

## Talking to the person

With a messenger set up (a `telegram:` section in `plugins.yaml`, see
[docs/plugins.md](../../docs/plugins.md#chat-adapters)), every run has a conversation with the person:
a topic in one Telegram group, opened by the run's first message. A nested run uses its root's.

- **flowd writes there by itself**: "`<run>` waits for you: …" when the run reaches a human step, a
  `flow wait --human` or stops for the person, and "`<run>` is done / was stopped" at the end. Do not
  make steps announce those. Switch and word them with `notify`: on a step file or an entry
  `{waits, waits_text, done, done_text}` (`done` — "this step is done" — is off by default), on the
  process `{end, done_text, stopped_text}`; texts take `{{run.*}}`, `{{vars.*}}`, `{{step.*}}`,
  `{{note}}`, `{{reason}}` (docs/processes.md, "Messages to the person").
- **An agent writes** with `flow say "…" [--file …]`; an `sh` entry with `flow say --run "$FLOW_RUN" "…"`.
  Write that into the prompt where it matters — a report, a decision, a result — not every step.
  An `.html` file arrives as a link when flowd serves reports (`FLOWS_REPORTS_URL`), else as a file.
- **The person's replies** in the topic are typed into the agent of the run's current step once its
  turn ends. With no agent on the step (an `sh`, a wait, a human step) they go to the agent that
  worked last, told the run is not at its step: it answers but cannot close the person's step. So a
  step that waits for a decision the agent should act on keeps its agent on it: `flow wait --human`.
- `flow say` fails with `no chat is set up` without a messenger: a prompt that relies on it should
  say what to do then (ask in the terminal).
- One bot per flowd: a second host needs its own bot (the same group is fine).

## New event sources and actions

Write a plugin, not daemon code: a TS file in `$FLOWS_HOME/plugins/` whose default export is
`{name, events, start?, watch?, actions?, title?, chat?, login?, stop?}` (`chat` makes it the
messenger, `login` the UI's login from outside), configured in `plugins.yaml` — see
[docs/plugins.md](../../docs/plugins.md). flowd loads plugins at start: ask the user before
restarting it (UI → Plugins → Restart, or `launchctl kickstart -k gui/$UID/local.flows`).
