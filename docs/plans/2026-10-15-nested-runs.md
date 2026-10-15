# Nested runs — plan

Spec: [2026-10-15-nested-runs-design.md](../specs/2026-10-15-nested-runs-design.md). Engine stage
only: CLI and HTTP, no UI beyond not breaking on the new entry kind. Each task: tests first, then
code, `npm test` and `npm run typecheck` green, one commit.

## 1. Definitions: the `inner` entry

Files: `src/types.ts`, `src/defs.ts`, `test/defs.test.ts`.

- `EntryKind` gains `"inner"`. `ENTRY_KEYS` gains `inner`.
- `{inner: true, role: dev}`: kind `inner`, default id `inner`. It takes `id`, `role`, `timeout`,
  `on_fail`, `retries`, `after`, `detour`. Refused, each with its own line:
  - `inner` other than `true` → `inner must be true`;
  - no role, `human`, or an undeclared role → `inner needs a declared agent role`;
  - with `step`, `do`, `wait_for`, `wait`, `sh`, `hold` → `inner runs another process; it cannot
    go with step, do, wait_for, wait, sh or hold`;
  - in a `repeat: true` process → fine (the parent may repeat; the child may not — checked at start).
- `test/defs.test.ts`: the entry parsed; each refusal; the default id; two `inner` entries need ids.

## 2. Engine: the parent side

Files: `src/types.ts`, `src/engine.ts`, `test/engine-runtime.test.ts`.

- `RunState`: `inner?: string[]` (the chain still to place, from `--inner`), `parent?: {run, entry,
  vars}` (the child's link, `vars` the copy it started with). `EntryState.child?: string`.
- Action `{kind: "start-child", entry, role, process, chain}`.
- Input `{kind: "child", entry, child}`: the daemon attached a child; refused unless `entry` is
  current, an `inner`, `waiting` and without a child.
- `proceed()` for `inner`: status `waiting`, no watch, no delivery. With `run.inner[0]`:
  `none` → skipped (`note: no inner process`, by `system`) and advance; a name → `start-child`
  with `chain: run.inner.slice(1)`. Without a chain: just waits.
- `tick`: an `inner` with a child never times out (the child's own steps have timeouts); without
  one, `timeout` applies as for any entry.
- `skip`, `retry`, `goto` on an `inner` with a child are refused: `<entry> has a nested run <child>
  open; stop it first`.
- Ending (`report` from the daemon) needs nothing new: `set` brings the vars, `report` closes it.
- Tests: waits without chain; `start-child` with the rest of the chain; `none` skips and advances;
  `child` attaches and is refused twice / on another entry; timeout only without a child;
  skip/retry/goto refused with a child, skip allowed without; report done → next entry, failed →
  `on_fail`.

## 3. Store: the top of a session

Files: `src/store.ts`, `test/store.test.ts`.

- `runBySession(session)` returns the top: among open runs bound to the session, the one no other
  of them names as `parent.run`. Every lookup (resolveTarget, `/api/vars`, the hook, spawn reuse)
  already goes through it.
- New `childrenOf(runId)`: open runs whose `parent.run` is it.
- Tests: one run → it; parent + child on one session → child; child closed → parent.

## 4. Daemon: starting a child

Files: `src/daemon.ts`, `test/daemon.test.ts`.

- `startRun(name, bind, trigger, ev, vars, opts?: {inner?: string[]; parent?: {run, entry}})`.
- Chain check (from `flow start --inner`, before anything is created): every name a valid
  process; none `repeat`; a name (or `none`) after a process without an `inner` entry →
  `<B> has no inner step, so <C> has nowhere to go`; `none` must be last.
- A session in `bind` that is taken:
  - its top run stands on an `inner` whose role is bound to that session, waiting, with no child
    → that run becomes the parent;
  - otherwise refused: `<role> is busy with <run> at step <entry>; a nested process can start when
    it reaches inner`.
- With a parent:
  - the child's `do: clear` on the lent role → refused: `<B> clears <role>'s context, which <A>
    still needs; use compact`;
  - the child starts with `{...parent.vars, ...vars}` and `parent = {run, entry, vars: that copy}`;
  - the parent gets `{kind: "child"}` before the child's `start` (so a fast child cannot end
    unattached); a queued child is attached as well.
- Action `start-child` (in `commit`): the lent role's child role is the one named like the
  `inner` entry's role, else the child's only role; otherwise the parent's `inner` fails:
  `<B> has roles a, b; none is <role>`. Any start error fails the `inner` the same way
  (`entry.report` failed, by `system`).
- Tests: a chain starts A, then B on A's `inner`, then C on B's; chain refusals; a manual start on
  a busy session accepted on `inner` / refused elsewhere with the text; role matching; `clear`
  refused; a queued child is attached; the child's vars are the parent's plus `--var`.

## 5. Daemon: ends

Files: `src/daemon.ts`, `test/daemon.test.ts`.

- In `commit`, a run that turned terminal and has a `parent` whose current entry still has it as
  `child`:
  - `done` → `run.set` with the vars that differ from `parent.vars`, then `entry.report` done
    (`note: <child> done`);
  - `stopped` → `entry.report` failed with the child's reason (`<child> stopped`).
- A run that turned `stopped` stops its open children (`childrenOf`).
- Start-up: a parent on `inner` whose child is closed gets the same end (a restart between the
  two applies).
- Turn ends on the lent session go to every run bound to it, as today: the parent's `inner` is
  never active, so they change nothing there — a test pins that.
- Tests: done → vars back (only the changed ones) and the next step delivered to the same
  session; stopped child → `on_fail`; parent stop → child stopped; restart reconciliation; three
  levels unwind in order.

## 6. CLI and HTTP

Files: `src/cli.ts`, `src/http.ts`, `test/cli.test.ts`, `test/http.test.ts`.

- `flow start <process> --inner <process|none> …` (repeatable, order kept) → body `inner: [...]`.
- `flow skip [<run>] --note "…"`: the current entry of the run (or this session's top run) via
  the existing skip route. Usage and help text.
- `POST /api/runs` takes `inner` (list of strings); 400 otherwise.
- `flow show` / `RunSummary`: `parent` and `child` so CLI and a later UI can show the nesting;
  `flow ls` marks a child (`↳ <parent>`).
- Tests: arguments reach the daemon; skip with and without a run; the summary fields.

## 7. UI: not breaking

Files: `ui/app.js`, `ui/text.js`, `test/ui-text.test.ts`.

- The entry phrase of `inner`: "Waits for a nested process" / "Ждёт вложенный процесс", and with a
  child "Nested: <child>" / "Вложенный: <child>". Nothing else: the real UI is designed with the
  designer afterwards (spec, "UI").

## 8. Documentation

- `docs/processes.md`: the `inner` entry, `--inner`, the stack, vars down and back, ends, refusals.
- `docs/concepts.md`: a session's stack of runs; the top gets the session's events.
- `docs/cli.md`: `--inner`, `flow skip`. `docs/http-api.md`: `inner` in the start body, summary fields.
- `skills/flow-author/SKILL.md`: a row in "Choosing an entry" and a trap (a start on a busy agent
  only works on `inner`; `clear` in a child).
- `docs/troubleshooting.md`: "already busy" refusal.
- `CLAUDE.md` map unchanged (no new files).

## 9. By hand, after the user says yes

A two-level demo in a temp `FLOWS_HOME`-like process with harmless steps (`sh` and one agent step
that only runs `flow done`): outer `inner` → inner process → back, then a three-level chain. Then
ship: restart flowd, push.

## After

The UI design session with the designer, then its own spec and plan.
