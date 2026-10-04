# Open-source-ready flows: docs, agent conventions, authoring skill

Status: design agreed 2026-10-04 (maintainer, Claude). Not implemented yet.

## Problem

flows works (the first spec: `docs/specs/2026-10-04-flows-design.md`), but the repo reads like a
private workspace. The README is a 72-line note. Personal and employer-specific names sit in the
code and the examples. Design records live under a tool-specific path. Nothing tells the next agent
how work is done in this repo. And an agent asked to "add a step" or "make a process" has to
reverse-engineer the YAML format from the source.

## Goals

1. **Publishable.** A stranger can clone it, understand what it is in a minute, install it and
   run the demo. Nothing personal or employer-internal is left in tracked files apart from the
   copyright line. Publishing itself (remote, push, npm) is out of scope.
2. **Documented.** A short README plus reference docs that match the code, with a test that
   fails when they drift on the facts a test can check.
3. **Agent conventions.** `CLAUDE.md` (and `AGENTS.md` for Codex) makes every non-trivial change
   go spec → plan → implementation → documentation, and states the code, test and safety rules
   learned while building flows.
4. **Authoring skill.** A second skill, `flow-author`, lets an agent create or change steps,
   processes, triggers and plugins correctly, and check its work with a new `flow check`.

## Non-goals

Fixing the deferred findings (they are recorded, not fixed); new runtime features other than
`flow check`; CI, a remote, an npm release, a CHANGELOG, a docs site.

## Repository layout after the change

```
README.md            what and why, screenshot, requirements, install, 5-minute quickstart, links
LICENSE              MIT
CONTRIBUTING.md      the four-stage workflow for humans, how to run tests, where things go
CLAUDE.md            conventions for agents; AGENTS.md is a symlink to it
docs/
  concepts.md        steps, processes, roles, runs, events, delivery, the run lifecycle
  processes.md       reference: every key of a step file, a process and an entry; validation; templates; recipes
  plugins.md         writing a plugin: interface, ctx, start/watch/actions, the gh plugin as a worked example
  cli.md             every flow command
  http-api.md        every endpoint
  architecture.md    modules, an event's path, storage, delivery, security model
  troubleshooting.md flowd not running, a line that did not submit, hooks, logs, resetting state
  assets/            UI screenshots taken on demo data
  specs/  plans/     design records (the existing ones move here from docs/superpowers/)
  backlog/           deferred work, one file per item
skills/
  flow/SKILL.md          unchanged role skill (moves from skill/)
  flow-author/SKILL.md   new authoring skill
examples/            demo + pr-loop (replaces ts-wave)
```

## Decisions

### Publication cleanup

- Code and tests: the refusal that named the maintainer as the one who closes a human step becomes
  `<step> is the human's step; a human closes it`; comments name "the user", not a person.
- Examples: `ts-wave` (an employer project) is replaced by `pr-loop`, a neutral two-role sample:
  a lead picks a task and reviews, a dev implements, the lead opens a PR, CI is awaited, a human
  merges, a detour fixes red CI. `demo-approve` speaks of "the human".
- The moved design records keep their substance; employer project names in them are replaced by
  neutral descriptions ("a JS→TS migration", "an observability programme").
- Acceptance check: the personal/employer-name grep (the maintainer's name, the employer's product and ticket names, the old manager skill, the home-directory path)
  returns nothing outside `LICENSE`. The pattern itself is kept out of the repo, since it would match itself.
- `package.json`: drop `private`, add `description`, `license: MIT`, `engines.node: ">=24"`,
  `keywords`. `.gitignore` gains `.superpowers/`.

### `flow check [name]`

Validates `$FLOWS_HOME` offline, with the same loader and plugin set flowd uses (built-in
`plugins/` then `$FLOWS_HOME/plugins/`), so it works whether or not flowd runs. It prints one line
per problem (`process pr-loop: steps[3]: undeclared role dev`, `step task-pick: summary is required`,
`plugin slack: <load error>`) and exits 1 if there is any; otherwise it prints
`<n> processes and <m> steps are valid` (or `<name> is valid`) and exits 0. With a name it reports
only that process or step, and `no process or step named <name>` (exit 1) if neither exists.

### Skills

`skill/flow` moves to `skills/flow`; `skills/flow-author` is new. `flow install` links both into
`~/.claude/skills/`, replacing an older link of its own. `flow-author` holds the working procedure
and the traps; the full key reference stays in `docs/processes.md` and `docs/plugins.md`, which
the skill points to by absolute path resolved from its own location — the skill does not copy them.

### Docs stay true

`test/docs.test.ts` fails when:
- a relative Markdown link in `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/*.md` or
  `skills/*/SKILL.md` points to a missing file;
- a process or entry key the loader accepts is missing from `docs/processes.md`;
- a `flow` command the CLI handles is missing from `docs/cli.md`;
- a core `flow.*` event is missing from `docs/concepts.md`;
- a skill file lacks `name` and `description` frontmatter.

### Backlog

The findings deferred at the end of the first implementation become `docs/backlog/<slug>.md`, one
per item, frontmatter `worth: high|medium|low`, `where: <file or area>`, `added: 2026-10-04`, then
what happens, why it matters, and the fix if known. Fixing an item deletes its file.

### Agent conventions (CLAUDE.md)

1. The workflow: spec (approved by a human) → plan (tasks with tests and code) → implementation
   (TDD, a commit per task, tests and typecheck green) → documentation (docs, README, skills,
   examples updated). A task is not done until the docs match. A small fix skips the spec and
   plan but not the test or the docs.
2. Repo map and module responsibilities.
3. Code rules: erasable TypeScript, `.ts` imports, runtime deps only `yaml` and `croner`, the
   engine stays pure, I/O lives in the daemon, every agterm call goes through `src/agterm.ts`.
4. Test rules: `node:test`, temp dirs and fakes only, never the real agterm, `~/.config/flows`,
   `~/.claude` or launchd; set `AGTERM_SESSION_ID` explicitly.
5. Ask a human before `flow install`, restarting the launchd agent, or live runs in agterm.
6. Deferred work goes to `docs/backlog/`.
7. Writing: docs and commit messages in plain English; conventional commits.

## Testing

`test/check.test.ts` (offline validation, filtering by name, exit codes, a plugin load error),
the updated `test/install.test.ts` (both skills linked, an old `skill/flow` link replaced),
`test/examples.test.ts` (demo and pr-loop valid), `test/docs.test.ts` (above). The existing 104
tests keep passing. A manual check renders the README screenshots from a throwaway flowd on demo
data.
