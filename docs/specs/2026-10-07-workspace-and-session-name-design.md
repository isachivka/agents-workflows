# Where a role's session lives, and what it is called

## Problem

flowd spawns every role into a workspace named after its process and names the session
`<run id> <role>`. A family of processes (a daily job, a weekly check, a manual investigation)
cannot share one workspace, and a daily run's session cannot say which day it is.

## Decisions

- **`workspace:` on a process**: free text, the agterm workspace its roles spawn into; default the
  process name. Several processes may name the same one.
- **`name:` on a role**: a template over `run`, `vars` and `role`, rendered at spawn; default
  `{{run.id}} {{role}}`. A render error fails the spawn like any other (retried, then the role
  fails with the reason).
- **`{{run.date}}`**: the local `YYYY-MM-DD` the run started. The engine records `startedAt` on
  `start`; runs started before this change have no date.
- **Docs**: the close-the-terminal recipe deletes the workspace only when the run owns it; a shared
  `workspace:` closes its own session.
- No per-role workspace until someone needs it.

## Testing

Defs: both keys parse, bad values are refused. Daemon: the spawn uses the workspace and the
rendered name. Engine: `run.date` is the start day.
