---
worth: low
where: plugins/gh.ts realExec
added: 2026-10-05
---
gh runs in the process's `cwd`. When that directory does not exist (for example a copied example's
`~/code/my-repo`), `execFile` fails with `spawn gh ENOENT` and empty stderr, so the error shown is
only `gh pr list: exit 1`. PR-mode waits on a PR URL, which used to ignore the cwd, now fail the
same way. Fix: check the cwd first and say `cwd <path> does not exist`, or run without a cwd when
the PR is a URL or `with.repo` names the repo.
