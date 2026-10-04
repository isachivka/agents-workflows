---
summary: The dev implements the task in its worktree and commits
---
Work only in {{vars.worktree}} (use absolute paths). If {{vars.worktree}}/REVIEW.md exists, this
is another attempt: fix what it lists first. Implement "{{vars.task}}" test-first, run the
project's tests, and commit (never commit REVIEW.md). Then
`flow done --note "<what changed, test result>"`.
