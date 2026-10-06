# No Typing Over the User Implementation Plan

**Goal:** Stop false reminders on `idle`, and never type a line into a session whose input box holds the user's draft or that has an overlay open.

**Spec:** `docs/specs/2026-10-07-no-typing-over-the-user-design.md`. Follow `CLAUDE.md`.

## Tasks

### Task 1: Engine — only `completed` ends a turn
Files: `src/engine.ts` (`session` input), `test/engine-runtime.test.ts`, `test/daemon.test.ts`.
- Test first: `active` → `idle` → +30 s tick: nothing delivered, no `remindAt`; a declared wait stays unparked on `idle` and parks on `completed`.
- Change the turn-end branch from `completed || idle` to `completed`.
- Existing tests that end a turn with `idle` switch to `completed`.

### Task 2: Daemon — defer delivery while the user is in the session
Files: `src/agterm.ts` (`SessionInfo.overlay`, `Agterm.text(session)`, `composerDraft(screen)`), `src/daemon.ts` (`doFlush`), `test/agterm.test.ts`, `test/daemon.test.ts`, `test/daemon-helpers.ts` (`FakeAgterm.text`, `overlay`).
- `composerDraft(screen: string): string` — the text between the last two lines made of `─` (20 or more), minus a leading prompt mark (`❯`, `›`, `>`), trimmed. No two rules → `""`.
- `realAgterm().text(id)` runs `agtermctl session text --target <id>`; `tree()` carries `overlay`.
- In `doFlush`, after the active/gap checks and before typing into a bound session: if the session's tree entry has `overlay`, or `composerDraft(await agterm.text(id))` is non-empty, `continue` (the row stays pending). Any error reading either → type as before.
- Tests first: parser cases from the spec (use real screen shapes: a rule line may carry a title, e.g. `──── name ─`); daemon: draft present → nothing typed; draft cleared → typed; overlay → nothing typed.

### Task 3: Docs
`docs/concepts.md` (Delivery: never over a draft or an overlay; Reminders: `completed` ends a turn, `idle` does not), `docs/troubleshooting.md` (a line that waits: the session has a draft or an overlay). `npm test && npm run typecheck`; one commit per task.
