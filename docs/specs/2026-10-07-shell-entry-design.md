# A shell entry: `sh: <command>`

Status: approved 2026-10-07 by the user.

## Problem

Small mechanical steps — create a worktree, mark files viewed, remove a worktree, call a script —
need either a whole agent turn or a plugin. flowd should run a shell command itself.

## Decision

```yaml
- {sh: 'git -C ~/code/repo worktree add "$FLOW_VAR_WORKTREE" "$FLOW_VAR_BRANCH"'}
- {id: viewed, sh: 'gh-mark-viewed "$FLOW_VAR_PR"', cwd: "~/code/repo", on_fail: retry}
```

- flowd runs the command with `/bin/zsh -lc` (a login shell: `gh`, `git`, `flow` on PATH) in the
  entry's `cwd` (a template over `run` and `vars`), else the process `cwd`.
- **No templates in the command.** Run data reaches it as environment variables only, so a value
  that came from outside (a PR title in a GitHub event) can never run as code:
  `FLOW_RUN`, `FLOW_PROCESS`, `FLOW_ITERATION`, `FLOW_VAR_<NAME>` for every var, and
  `FLOW_EVENT_<KEY>` for every scalar field of the event that woke the entry. Names are upper-cased,
  anything but `A-Z0-9_` becomes `_`.
- Exit 0 → `done`, note = the last line of stdout (or `exit 0`). Otherwise → `failed`, note =
  `exit <code>: <the last 500 characters of stderr, else stdout>`; `on_fail`, `retries`, `goto`
  apply as for any entry.
- To hand a value to later steps the command calls `flow set --run "$FLOW_RUN" key=value`.
- It is killed after the entry's `timeout`, or 30 minutes without one, and fails with
  `timed out`. If flowd restarts while it runs, the entry fails with
  `flowd restarted while the command ran`, as a plugin action does.
- It runs as the user, without a sandbox, like the agents a process spawns.
- Default id `sh`. `sh` stands alone (no `step`, `do`, `wait`, `role`); `wait_for` before it is
  allowed. `cwd` on an entry is only for `sh`.
- The UI names it "flows runs `<command>`".

## Testing

defs: parsing, default id, exclusivity, `cwd` only with `sh`. Engine: the action carries the
command, the rendered cwd and the environment; no template rendering of the command. Daemon (shell
`/bin/sh -c` in tests): done with the last stdout line; failed with exit code and stderr; vars and
event fields arrive as env; a timeout kills it; a restart mid-command fails the entry.
