# Nested runs in the UI — plan

Spec: [2026-10-15-nested-runs-ui-design.md](../specs/2026-10-15-nested-runs-ui-design.md). Tests
first, `npm test` and `npm run typecheck` green, one commit per task.

1. **API** (`src/daemon.ts`, `src/http.ts`, `test/http.test.ts`, `test/daemon-nested.test.ts`):
   `needsYou` on a bare waiting `inner` (no child, no chain); `POST /api/runs/:id/nest {process}`
   submits `run.nest` with `ui: true`, whose refusal is returned instead of failing the `inner`.
2. **Text** (`ui/text.js`, `test/ui-text.test.ts`): situation `nest` and its `describeRun`; strings
   for the tab ("under it", "then: …"), "Inside runs …", "busy with …", "When it ends" and its three
   lines, the picker, Start on agent, Skip, in en and ru.
3. **Now** (`ui/app.js`, `ui/style.css`): group runs into stacks by `parent`/`child`; render the
   top run's card with tabs (`StackTabs`); the `nest` card (`NestPicker`, shared with the run page);
   counts by stacks.
4. **Run page** (`ui/app.js`, `ui/style.css`): `Current` for `inner` (child link, `ChildSteps` mini
   timeline, Stop child; or `NestPicker`); `Agents` "busy with"; for a nested run the tab above the
   header and the "When it ends" block.
5. **Preview data** (`scripts/ui-preview.ts`): a two-level and a three-level stack, a bare `inner`,
   a nested run page.
6. **Docs**: `docs/http-api.md` (nest route, `needsYou`), `README.md` if it describes the Now page,
   the UI section of `docs/processes.md` "Nested runs".
7. **By hand**: preview screens, then a shell-only demo on the real flowd; restart, push.
