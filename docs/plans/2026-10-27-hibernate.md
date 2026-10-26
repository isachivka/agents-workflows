# Plan: hibernate

Spec: [2026-10-27-hibernate-design.md](../specs/2026-10-27-hibernate-design.md).

1. **Types, defs, engine** (`src/types.ts`, `src/defs.ts`, `src/engine.ts`, `test/defs.test.ts`,
   `test/engine-runtime.test.ts`): `Process.hibernateMs`, `RunState.asleep`; `hibernate:` parsed as a
   duration; an engine input `sleep` that unbinds the role and records it; a `bind` to a session clears it.
2. **Sleeping** (`src/agterm.ts` `close`, `src/daemon.ts`, `test/daemon.test.ts`, fakes): on tick, a parked
   run of a hibernating process past its time gets each idle Claude/Codex role's conversation found,
   `role.sleep` submitted, the session closed; the exclusions of the spec; a process without the key never.
3. **Waking** (`src/daemon.ts`): a line to a sleeping role spawns `--resume <id>` with the line, in the
   conversation's cwd; a person's message reaches a sleeping role; restore on a sleeping role reopens and
   binds it.
4. **UI and docs**: `asleep` in the run summary; the agents box shows "asleep" with a Wake button (the
   restore endpoint); `docs/processes.md`, `skills/flow-author`, `docs/http-api.md`.
