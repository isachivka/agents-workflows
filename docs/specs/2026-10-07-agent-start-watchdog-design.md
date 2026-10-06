# A step whose agent never starts: the start watchdog

Status: approved 2026-10-07 by the user ("short spec/plan/fix").

## Problem

The first run of a real process spawned Claude Code in a repository checkout, a folder
Claude had not trusted yet. Claude stopped at its "Is this a project you trust?" dialog with the
step's first line waiting behind it. flowd saw nothing wrong: the line counted as delivered, the
session never went `active`, and reminders only start after an `active`. The run sat "running"
until the user noticed and answered the dialog by hand.

The same silent hang happens to any line that reaches the session but never starts a turn: a
typed line that does not submit (`docs/backlog/silent-submit-stuck-step.md`), a login or update
prompt, an agent that crashes on start.

## Decisions

1. **Start watchdog (engine).** A line delivered to an agent step must start a turn: if the
   session has not gone `active` within **2 minutes** of `deliveredAt`, and the step has no
   `flow wait`, the run goes `needs-human` with
   `<step>: the agent has not started 2 min after its line was delivered — look at its terminal (a trust or login prompt, an error)`.
   It covers nudges and reminders alike (both set `deliveredAt` and clear `sawActive`).
2. **The likely cause, said plainly (daemon).** Before spawning a role whose `spawn` runs
   `claude`, flowd reads `~/.claude.json` (`CLAUDE_CONFIG_DIR/.claude.json` when that is set) and
   checks `projects[<cwd>].hasTrustDialogAccepted`. When the folder is not trusted it still
   spawns (the dialog must be answered in that session), then stops the run for the user at once
   with `<step>: Claude Code has not trusted <cwd> yet — open the session and choose "Yes, I trust this folder"`.
   flowd never writes `~/.claude.json` and never answers the dialog itself: trusting a folder is
   the user's decision, and Claude rewrites that file while it runs.
3. **It clears itself.** Both stops record the entry they are about (`RunState.startBlocked`).
   When that entry's session goes `active` — the user answered the prompt and the agent began —
   the run resumes on its own. The user only has to deal with the terminal.

## Testing

Engine: no `active` within 2 min of delivery → `needs-human` with the reason; an `active` before
then → nothing; a parked `flow wait` → nothing; a reminder that never starts a turn → stopped;
the `active` that finally comes resumes a start-blocked run and clears `startBlocked`; a halt
for another reason is not resumed by `active`. Daemon: an untrusted cwd for a `claude` spawn
stops the run with the trust reason right after the spawn, a trusted one does not, a non-claude
spawn is not checked; the config path is injectable. Docs: `concepts.md` (reminders section),
`troubleshooting.md` (trust prompt, agent not starting); the backlog item
`silent-submit-stuck-step` is resolved and deleted.
