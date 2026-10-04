# flows — review profile

## What the software is

- `flowd`: a local Node 24 daemon (TypeScript by type stripping, no build) that runs agent
  processes built from reusable steps across agterm terminal sessions; `flow`: its CLI; a vendored
  Preact+htm web UI on `127.0.0.1:7420`.
- Single user, single machine (macOS). Agents are Claude Code sessions, usually started with
  `--dangerously-skip-permissions`.
- Pure engine (`src/engine.ts`) → actions; `src/daemon.ts` executes them; SQLite store; plugins
  (`plugins/gh.ts`) for event sources.

## What a real failure looks like here

- A run that silently stops moving: an entry left `active`/`waiting` forever, a line queued but
  never typed, a nudge typed but not submitted, an event that never wakes its wait.
- A run that moves wrongly: a step closed twice, an agent closing a step it never received, a
  `goto`/detour/retry going to the wrong entry, a restart that loses or replays state.
- Text typed into the wrong agterm session, or into a session mid-turn.
- flowd driven by something other than its own UI, the CLI or the hooks (a web page, DNS
  rebinding) — anything that reaches it can make an agent run code.
- `flow install` damaging the user's `~/.claude/settings.json`, `~/.config/agterm/hooks.conf` or
  launchd setup.
- A doc, skill or example that states something the code does not do: agents act on
  `docs/*.md` and `skills/*/SKILL.md` literally.

## Blast radius

- The user's own machine and repos: agents with skip-permissions act on whatever a prompt says.
- No network service, no multi-tenancy, no auth by design (localhost only, Host/Origin/JSON guard).

## Reporting bar

- Report what would make a run stall, misroute, lose state, act without the user, or mislead an
  agent reading the docs. A plausible input that triggers it is enough; no need for a repro.
- Known deferred problems are listed one per file in `docs/backlog/`; do not re-report those as
  new — mention only if the code makes one worse or the file is wrong.
- Style, naming and refactors without a behavioural consequence: skip.

## Deliberate conventions (not defects)

- Only erasable TypeScript, `.ts` in relative imports, `import type` for types.
- Runtime deps only `yaml` and `croner`; no build step; UI is plain browser JS.
- Engine has no I/O; time arrives as `ctx.now`; every `agtermctl` call goes through
  `src/agterm.ts`.
- No authentication on the HTTP API (localhost only, by design).
- `docs/specs/` and `docs/plans/` are historical records and may describe files that later moved.
- `ponytail:` comments mark a known, deliberate simplification with its ceiling.
- Tests use temp dirs and fakes only; they never touch real agterm, `~/.claude` or launchd.
