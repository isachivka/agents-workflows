---
summary: PM picks the next wave and prepares its worktree
---
Pick the next wave as /migration-pm "Picking the next wave" says. Create a fresh worktree for it off
the current origin/develop. Then run `flow set wave=<N> worktree=<absolute path>` and
`flow done --note "wave <N>: <files>"`.
