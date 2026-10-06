# Start Watchdog Implementation Plan

**Goal:** Stop the run for the user, with the cause, when a delivered line never starts the agent's turn; name the Claude folder-trust prompt when that is the cause; resume by itself once the agent starts.

**Spec:** `docs/specs/2026-10-07-agent-start-watchdog-design.md`. Follow `CLAUDE.md`.

## Tasks

### Task 1: Engine — the watchdog and self-clearing start blocks
Files: `src/types.ts`, `src/engine.ts`, `test/engine-runtime.test.ts`.
- `START_TIMEOUT_MS = 120_000`; `RunState.startBlocked?: string` (entry id); input `{ kind: "start-blocked"; entry: string; reason: string }`.
- `tick`, for the current agent entry that is `active`, delivered, without `sawActive` and without `wait`: when `now - deliveredAt >= START_TIMEOUT_MS`, `startBlocked = entry`, halt with the spec's reason.
- `start-blocked` input: same halt with the given reason, for the current entry only.
- `session` `active` for the current entry's role: if `run.startBlocked === cur.id`, clear it and resume (`needs-human` → `running`). Any halt clears nothing else; `resume()` paths that run anyway (report, goto, retry) also clear `startBlocked`.
- Tests first: the five engine cases in the spec.

### Task 2: Daemon — trust preflight for claude spawns
Files: `src/daemon.ts`, `test/daemon.test.ts`, `test/daemon-helpers.ts`.
- `FlowdOptions.claudeConfig?: string` (default `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`); tests point it at a temp file.
- In `spawnFor`, after a successful spawn and bind: if the role's `spawn` command's first word's basename is `claude` and the config does not mark the rendered `cwd` trusted (missing file or unreadable JSON count as untrusted only when the file exists but lacks the project; a missing file is skipped), submit `entry.start-blocked` → engine `start-blocked` with the trust reason. Handle the event type in `handle()`.
- Tests first: untrusted → `needs-human` with the trust reason and `startBlocked`; trusted → running; `codex` spawn → not checked; then a status `active` from that session resumes the run.

### Task 3: Docs and backlog
- `docs/concepts.md` "Reminders and timeouts": the 2-minute start watchdog, the trust check, the self-resume.
- `docs/troubleshooting.md`: "a run stopped: the agent has not started" and "Claude Code has not trusted <folder>".
- Delete `docs/backlog/silent-submit-stuck-step.md` (this resolves it: a typed line that never submits now stops the run after 2 minutes) and fix any doc linking it.
- `npm test && npm run typecheck`; one commit per task.
