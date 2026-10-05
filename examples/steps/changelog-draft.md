---
summary: The writer drafts a changelog entry for the merged PR
---
{{vars.pr}} ("{{vars.title}}", by {{vars.author}}) was just merged into {{vars.base}}. Read it with
`gh pr view {{vars.pr}}`. Pull the default branch, then add one entry for it under the
"Unreleased" heading of CHANGELOG.md, in the file's existing style: what changed for a user, one
or two lines, with the PR number #{{vars.number}}. Do not commit. Then
`flow done --note "<the entry>"`.
