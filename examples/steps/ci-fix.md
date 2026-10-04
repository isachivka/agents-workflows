---
summary: The dev fixes red CI
---
Required CI checks failed on {{vars.pr}}. Read them with `gh pr checks {{vars.pr}}`, fix the cause
in {{vars.worktree}}, push, then `flow done`. Never skip or weaken a test to get green; if that is
the only way, `flow failed --note "<why>"`.
