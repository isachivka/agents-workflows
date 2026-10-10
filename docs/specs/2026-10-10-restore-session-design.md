# Restore a finished run's agent session

## Problem

A process's last step often closes the agent's terminal (`agtermctl workspace delete`). Later the
user wants to ask that agent something: what it did, why, to do one more thing. The conversation
still exists in Claude Code's transcripts, but finding and resuming it by hand is tedious.

## Decisions

- **Finding the conversation.** Claude Code keeps each session as
  `~/.claude/projects/<project>/<session>.jsonl` (`$CLAUDE_CONFIG_DIR/projects` when set). Every
  line flowd types names the run: `▶ flow: step <entry> · <run> it.<n>`. The role's conversation is
  the latest transcript in which a person's turn (not a tool result, not a subagent) is such a line
  for one of the role's entries. Only files written after the run was created are read. Works for
  runs that finished before this change; no hook is needed.
- **Restoring.** A new agterm session in the transcript's `cwd`, in the process's workspace, named
  `<the role's usual name> (restored)`, running `<the role's spawn> --resume <id>` with no prompt,
  then focused. The run does not change. A role whose session is still open is just focused.
- **Which roles.** Claude agents in agterm (`spawn` starts with `claude`, not `terminal: zmx`):
  `RunSummary.resumable`. The UI offers **Restore session** on a finished run's role that had a
  session and no longer has one, in "Recently finished" and on the run page.
- Not found → 409 "no conversation of <run> <role> …".

## Non-goals

Codex and other agents, zmx runs, putting the restored agent back into the run.

## Testing

`test/transcripts.test.ts`: latest per role, the run id not matched as a prefix (`#7` vs `#70`),
tool results and subagents ignored, old files skipped, a missing root. Daemon: open session focused,
not found, restored with `--resume` in the transcript's cwd, run unchanged. HTTP: the route and 409.
