---
worth: low
where: src/cli.ts, src/http.ts /api/report
added: 2026-10-04
---
`flow done --human` without `--run`/`--step` resolves the step from the session, like an agent's report, but as the human, so it skips the guard that an agent's step must have reached the agent. An agent could close a step it never saw. Fix: require `--run` and `--step` with `--human`.
