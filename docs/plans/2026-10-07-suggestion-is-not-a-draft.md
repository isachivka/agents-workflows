# Suggestion Is Not a Draft Implementation Plan

**Spec:** `docs/specs/2026-10-07-suggestion-is-not-a-draft-design.md`.

1. `src/agterm.ts`: `SessionInfo.surface?: string` (the `left` surface id from `tree`); `Agterm.cursorColumn(surface): Promise<number>` via `agtermctl surface cursor --target <surface>`; drop `text()` and `composerDraft()`. Tests in `test/agterm.test.ts` (fake agtermctl answers `surface cursor`).
2. `src/daemon.ts` `userInSession`: overlay → hold; else the session's surface's column > 2 → hold; any error or no surface → type. `FakeAgterm` gets `columns`/`surface`. Tests: suggestion-shaped screen irrelevant, column 2 → typed; 7 → held then typed at 2; throwing cursor → typed; overlay → held.
3. Docs: `concepts.md` delivery bullet, `troubleshooting.md` entry. `npm test && npm run typecheck`; one commit per step.
