# Nested runs in the UI

## Problem

The engine runs one process inside another on the same agent (`inner`, see
[2026-10-15-nested-runs-design.md](2026-10-15-nested-runs-design.md)). The UI shows each run as if
it stood alone: a parent waiting on `inner` sits among "working" runs with nothing to do there, a
nested run gives no hint of what it runs inside or what happens after it, and a run waiting for
a nested process to be chosen offers no way to choose. The user found nesting hard to follow in
text and diagrams; a stack of errands made it clear. The mockups were agreed with the user on the
flows design canvas (page "Вложенные флоу").

## Decisions

### Now: a stack of cards

- A run with an open nested run is not a card of its own: its nested run is, and above that card
  each run under it shows as a tab peeking out ("under it · jira-task #4 · then: <its next
  step>"), the deepest one furthest back. A tab links to that run's page. Counts and the lead
  sentence count stacks, not runs.
- A run standing on `inner` with nothing nested and no `--inner` left is waiting for the person:
  `needsYou` (daemon), situation `nest` (UI). Its card is under "Waiting for you": tag "Choose
  what runs inside", the run's title, the text "… reached the place where another process runs on
  agent <role>. Choose it, or skip", a process picker (valid, non-repeating processes), **Start on
  agent <role>** and **Skip**.

### Run page of a parent

- The current `inner` step with a nested run: "Inside: <child> runs" (a link), and a small timeline
  of the child's steps (done, current, next, the person's), from `GET /api/runs/<child>`. Under
  "Step in": only **Stop <child>** (the step then fails and `on_fail` decides); a line says
  skipping is possible once nothing runs inside.
- Without a nested run: the same picker, Start and Skip as the Now card.
- Agents: a role lent to a nested run shows "busy with <child>".

### Run page of a nested run

- Above the header, the tab of the run under it (as on Now), linking there.
- A block "When it ends": who goes on and with what (the parent's next step), what goes back up
  (the vars this run has that differ from the parent's), and what stopping it does.

### API

- `POST /api/runs/:id/nest {process}`: start that process in the run's current `inner` (the
  daemon's `run.nest`, with the same role matching). A refusal comes back as the answer (409) and
  does not fail the `inner`, unlike a failed `--inner` chain.
- `RunSummary.needsYou` includes a current `inner` that waits with no nested run and no chain.

## Not now

Nested runs in the process page and the editor; dragging a run onto another.

## Testing

`test/ui-text.test.ts`: situation `nest`, its tag and lines in both languages, the tab text.
`test/http.test.ts`: the nest route (started, refused without failing the parent). Daemon:
`needsYou` on a bare `inner`. By hand: `node scripts/ui-preview.ts` gets fake data for a stack of
two and three, a bare `inner`, and a nested run page; then the real UI with a shell-only demo.
