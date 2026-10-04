---
summary: The lead picks the next task and prepares a worktree for it
---
Pick the next task from the repo's backlog (the oldest file in docs/backlog/, or the first open
item in TODO.md). Create a fresh git worktree for it off the default branch. Then run
`flow set task=<short title> worktree=<absolute path>` and `flow done --note "<task>"`.
