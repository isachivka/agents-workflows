# flows

Local agent processes built from reusable steps. `flowd` runs them across agterm sessions:
it types each step into the right session, `/clear`s and `/compact`s between steps, waits for
outside events (CI, a merge, a signal) and shows everything in a web UI at
http://127.0.0.1:7420.

Design: `docs/superpowers/specs/2026-10-04-flows-design.md`.

## Install

```bash
npm install
bin/flow install        # launchd agent local.flows, agterm hooks, Claude PostCompact hook,
                        # the `flow` skill and ~/.local/bin/flow
mkdir -p ~/.config/flows && cp -Rn examples/* ~/.config/flows/
```

`flow install` edits `~/.claude/settings.json` (backup: `settings.json.bak-flows`) and
`~/.config/agterm/hooks.conf`. Log: `~/.local/state/flows/flowd.log`.
Restart: `launchctl kickstart -k gui/$UID/local.flows`.

## Concepts

- **Step** — `steps/<id>.md`: frontmatter `summary`, body = prompt template with
  `{{run.id}}`, `{{vars.x}}`, `{{event.data.x}}`. A missing value stops the run for you.
- **Process** — `processes/<name>.yaml`: `description`, `cwd`, `roles`, `steps` (an ordered
  list), optional `repeat`, `max_runs`, `triggers` (`cron` or `on: <event>`).
- **Entry kinds** — `step` + agent role (typed into that role's session), `step` +
  `role: human` (closed by you), `do: clear | compact | type`, `do: <plugin>.<action>`,
  `wait_for: <event>` alone (the event closes it). Any entry can also `wait_for` an event first.
- **Flow control** — `on_fail: retry | human | {goto: id}`, `retries` (default 3),
  `after: {goto: id}`, `detour: true` (reached only by goto), `timeout: 2h`.
- **Run** — one instance: role → agterm session id, vars, step states, iteration.

## Agents

A role's session gets `▶ flow: step <id> · <run> it.<n> — run \`flow show\``. The agent runs
`flow show`, does the step and reports `flow done` / `flow failed --note …`; `flow set k=v`
stores run variables. The `flow` skill tells agents this.

## CLI

`flow show | done | failed | set | signal | start | ls | install | daemon` — `flow help`.
From your own terminal: `flow done --human --run ts-wave#3 --step wave-merge`.
Ad-hoc events: `flow signal deploy-done env=rc` emits `signal.deploy-done`.

## Plugins

A plugin is a TS file in `plugins/` (built in) or `~/.config/flows/plugins/` (yours; same name
wins). Its default export:

```ts
export default {
  name: "slack",
  events: ["dm"],                       // emitted as slack.dm
  start(ctx) { /* long-lived sources: ctx.emit({type: "dm", data: {...}}) */ },
  watch(w, ctx) { /* an entry waits on slack.*: poll, ctx.emit({type, run: w.run, entry: w.entry, outcome, data}) */ return () => {}; },
  actions: { post(args, ctx) { /* `do: slack.post` */ } },
};
```

`ctx.config` is the plugin's section of `~/.config/flows/plugins.yaml`. A thrown error shows on
the Plugins page; a failing `watch` is retried with backoff. Restart flowd after changing one.

Built in: `gh` — `gh.checks` (required checks finished; done = green), `gh.merged`,
`gh.review`, for `vars.pr` or `wait_for.with.pr`.

Verified on 2026-10-04 on live agterm with `examples/processes/demo.yaml`: spawn with the nudge as
Claude's first prompt, `flow show`/`set`/`done` from the agent, `/compact` closed by the
PostCompact hook, `/clear`, `flow signal` waking an agent step, the human step on the Runs page
under "Needs you", the `↗` jump selecting the session, and `flow ls --all` showing the run done.
