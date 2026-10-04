---
summary: PM re-runs the whole gate on the committed tree
---
Re-run the whole gate in {{vars.worktree}} on the committed tree, as /migration-pm "Gate" says.
Red: `flow failed --note "<what failed>"` — the wave goes back to the executor.
Green: `flow done --note "<gate summary>"`.
