# flows — conventions for agents working in this repo

flows is a local daemon (`flowd`) that runs agent processes built from reusable steps across
agterm sessions, with a CLI (`flow`) and a web UI. Read [README.md](README.md) and
[docs/architecture.md](docs/architecture.md) before changing code.

## How work is done: spec → plan → implementation → documentation

Every change that adds or changes behaviour goes through four stages, each leaving an artifact:

1. **Spec** — `docs/specs/YYYY-MM-DD-<topic>-design.md`: problem, goals, non-goals, decisions,
   testing. A human approves it before any code. (With superpowers: `brainstorming`.)
2. **Plan** — `docs/plans/YYYY-MM-DD-<topic>.md`: small tasks, each with its files, the failing
   test, the code, the commands and their expected output. A human reviews it.
   (With superpowers: `writing-plans`.)
3. **Implementation** — task by task, test first, one commit per task, `npm test` and
   `npm run typecheck` green after each. A deviation from the plan is explained in its commit.
4. **Documentation** — update everything the change made untrue or incomplete: `docs/*.md`,
   `README.md`, `skills/*/SKILL.md`, `examples/`, the CLI help. The change is not done while any
   of them describes the old behaviour. `test/docs.test.ts` catches some drift, not all.

A small fix (an obvious bug, a typo) skips the spec and the plan, never the test or the docs.
Specs and plans are records: never rewrite an old one to match new code — write a new one.

## Map

| Path | What |
|---|---|
| `src/types.ts` | every shared type: definitions, events, run state, engine inputs and actions |
| `src/template.ts` | `{{path}}` substitution, `RenderError` |
| `src/defs.ts` | parse and validate steps and processes, load `$FLOWS_HOME`, read/write definition files |
| `src/engine.ts` | the pure run state machine: `step(run, input, ctx) → {run, actions}` |
| `src/store.ts` | SQLite: runs, events, outbox, session statuses |
| `src/agterm.ts` | the `Terminal` interface; agterm behind it, the only caller of `agtermctl`; shell quoting |
| `src/zmx.ts` | the zmx terminal: headless sessions through the `zmx` CLI, the only caller of `zmx` |
| `src/plugins.ts` | plugin interface and host: loading, events, watches with backoff, actions |
| `src/daemon.ts` | `Flowd`: event loop, routing, action execution, outbox flush, ticks, cron, reloads, restart recovery |
| `src/http.ts` | JSON API, SSE, static UI, hook endpoints, the Host/Origin/content-type guard |
| `src/main.ts` | starts flowd and the HTTP server |
| `src/cli.ts`, `bin/flow` | the `flow` command |
| `src/check.ts` | `flow check`: offline validation |
| `src/install.ts` | `flow install`: launchd plist, hooks, skill links |
| `plugins/gh.ts` | built-in GitHub plugin |
| `ui/` | web UI, Preact + htm vendored, no build |
| `skills/flow`, `skills/flow-author` | skills for agents running steps / authoring definitions |
| `examples/` | a sample `$FLOWS_HOME` |
| `docs/` | reference docs; `specs/`, `plans/` records; `backlog/` deferred work |
| `test/` | `node:test` suites; `helpers.ts` drives the engine, `daemon-helpers.ts` and `http-helpers.ts` hold the fakes |

## Code

- Node 24 runs the TypeScript directly: erasable syntax only (no `enum`, `namespace`, constructor
  parameter properties), relative imports end in `.ts`, type-only imports use `import type`.
- Runtime dependencies are `yaml` and `croner`. Adding any dependency needs a human's yes.
- `src/engine.ts` stays pure: no I/O, time comes in as `ctx.now`; it returns actions and
  `src/daemon.ts` carries them out.
- Every `agtermctl` call goes through `src/agterm.ts`, every `zmx` call through `src/zmx.ts`; every
  database access through `src/store.ts`.
- A new event source or action is a plugin, not daemon code.
- A refusal tells the reader what is wrong and what to do about it.

## Tests

- `node:test` and `node:assert/strict`, files `test/*.test.ts`. New behaviour gets a test that
  fails first.
- Temp directories and fakes only. A test never touches the real agterm, `~/.config/flows`,
  `~/.local/state/flows`, `~/.claude` or launchd.
- Tests that run the CLI set `AGTERM_SESSION_ID` explicitly; the runner may itself be inside an
  agterm session.

## Shipping: main, restart, push — no confirmation

The user's standing instruction: do not ask before any of these.

- Work directly on `main`. No feature branches, no merge step.
- When a change is done (tests and typecheck green, docs updated), commit it to `main`.
- If it touches what the daemon runs (`src/`, `plugins/`, `ui/`), restart it:
  `launchctl kickstart -k gui/$UID/local.flows`. Runs survive a restart (state is in the database).
- Push: `git push origin main`. The repository is **public**: before pushing, check the commits
  for anything personal or employer-internal (people's names, logins, company or product names,
  private repository names, PR or ticket numbers, paths under a home directory) and rewrite it
  neutrally first. Skipping the check is the one thing worse than asking.
- Another session may be committing in the same checkout: stage only your own files.

## Ask a human first

- `flow install` (it changes launchd, `~/.config/agterm/hooks.conf`, `~/.claude/settings.json`),
  or starting runs that spawn agents in the real agterm.
- Adding a dependency, or loosening the HTTP Host/Origin/content-type checks.

## Deferred work

A real problem you are not fixing now goes to `docs/backlog/<slug>.md`: frontmatter
`worth: high|medium|low`, `where: <file or area>`, `added: YYYY-MM-DD`, then what happens, why it
matters, and the fix if known. Fixing it deletes the file in the same commit.

## Writing

Docs, comments and commit messages in plain English. Conventional commits (`feat(engine): …`,
`fix(http): …`, `docs: …`). Comments say why, not what.
