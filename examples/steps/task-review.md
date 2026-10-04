---
summary: The lead reviews the dev's commits
---
Review the new commits in {{vars.worktree}} against "{{vars.task}}". Run the tests yourself.
Something to fix: write what to fix to {{vars.worktree}}/REVIEW.md (replace the file, do not
commit it), then `flow failed --note "<one line>"` — the task goes back to the dev.
Good: delete REVIEW.md if it exists, then `flow done --note "<one-line verdict>"`.
