# Contributing

Changes to flows go through four stages — spec, plan, implementation, documentation — described in
[CLAUDE.md](CLAUDE.md). The same rules apply to people and to agents.

## Setup

Requirements: macOS, Node.js ≥ 24, agterm, Claude Code.

    npm install
    npm test
    npm run typecheck

Run a daemon that does not touch your real setup:

    FLOWS_HOME=$(mktemp -d) FLOWS_STATE=$(mktemp -d)/flows.db FLOWD_PORT=7499 bin/flow daemon

It still uses the real agterm: starting a process with agent roles there spawns real sessions.
Use processes with only human steps and waits to try the UI.

Tests never touch the real agterm, `~/.config/flows`, `~/.claude` or launchd; keep it that way.

## Where things go

| What | Where |
|---|---|
| A design (approved before work starts) | `docs/specs/YYYY-MM-DD-<topic>-design.md` |
| An implementation plan | `docs/plans/YYYY-MM-DD-<topic>.md` |
| Deferred work | `docs/backlog/<slug>.md`, one item per file |
| User and reference docs | `README.md`, `docs/*.md` |
| Agent skills | `skills/<name>/SKILL.md` |

## Pull requests

One topic per PR. Tests and typecheck green. Docs updated for whatever the change makes untrue.
Link the spec and plan when there are any. Conventional commit messages.

## Looking at the web UI

`node scripts/ui-preview.ts` starts a throwaway flowd on port 7421 (`PREVIEW_PORT` changes it) with
a fake agterm and runs in every state the UI draws. It never touches the real flowd, agterm or
`~/.config/flows`.
