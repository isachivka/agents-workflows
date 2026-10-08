# zmx as a second terminal — plan

Spec: [2026-10-08-zmx-terminal-design.md](../specs/2026-10-08-zmx-terminal-design.md). Read it first.

**Rules for this work.** One commit per task, `npm test` and `npm run typecheck` green after each.
`npm test` runs one file at a time; never start a second test run while one is going, and never
run test files in parallel (a runaway test once wrote 75 GB; `startFlowd` now fails a test past
5000 events). Tests never touch the real agterm, the real zmx socket directories,
`~/.config/flows`, `~/.local/state/flows` or `~/.claude`. Ship each task to `main`, restart flowd
when `src/`/`plugins/`/`ui/` changed, leak-check the unpushed commits, push. Task 8 (a live run)
needs the user's go.

**Facts checked by hand** (agterm's zmx 0.8.1, `ZMX_DIR=/tmp/fz-test`):
- `zmx run <name> -d <argv…>` creates the session if needed and types the argv into its shell,
  shell-quoting each word itself, then `; echo ZMX_TASK_COMPLETED:…`. With `exec` first, the program
  replaces the shell and the session ends when it exits (it then disappears from `zmx list`).
- The session's environment has `ZMX_SESSION=<name>`. The session's cwd is the cwd `zmx run` was
  started in.
- `printf 'text\r' | zmx type <name>` types text and presses Return; exit 0 = queued.
- `zmx screen <name>` prints one header line then the screen text. Header seen:
  `<revision> <cols> <rows> <cursorCol> <cursorRow> <n>` (e.g. `44 120 24 40 10 0`; cursor zero-based).
  Confirm the field order in agterm's patch (`ScreenHeader` in `scripts/zmx-patches/0001-*.patch`,
  agterm repo) before relying on it.
- `zmx list` lines: `  name=<n>\tpid=…\tclients=…\tcreated=…\tcwd=…[\t<label>=<v>…]`;
  with no sessions it prints `no sessions found in <dir>`.
- `zmx set <name> k=v …`: values only `[A-Za-z0-9-_.]` (`#` refused).
- The socket directory path must be short (unix socket limit): a long scratch path is refused with
  `socket directory path is too long`.

---

### Task 1: a `Terminal` interface; agterm behind it

**Files:** `src/agterm.ts`, `src/daemon.ts`, `src/http.ts`, `test/daemon-helpers.ts`.

- Rename the `Agterm` interface to `Terminal` (keep `export type Agterm = Terminal` only if it
  saves churn; drop it once nothing uses it). Shape:
  ```ts
  export interface Terminal {
    spawn(o: { cwd: string; command: string; workspace: string; name: string; env?: Record<string, string> }): Promise<string>;
    type(session: string, text: string): Promise<void>;
    press(session: string, keys: string): Promise<void>;
    text(session: string): Promise<string>;
    tree(): Promise<SessionInfo[]>;
    /** the user is typing in it, or something covers it: typing now would land on top */
    userInput(session: string): Promise<boolean>;
    focus(session: string): Promise<void>;
  }
  ```
  `realAgterm` keeps `reloadHooks` and `cursorColumn` as extras (install uses `reloadHooks`).
  Move the body of `Flowd.userInSession` into `realAgterm().userInput` (tree → overlay, surface →
  `cursorColumn > EMPTY_INPUT_COLUMN`, errors → false).
- `FakeAgterm` implements `userInput` the same way it answers today (overlay flag, `columns`).
- No behaviour change: the whole suite passes unchanged apart from renames.

### Task 2: `src/zmx.ts`

**Files:** create `src/zmx.ts`, `test/zmx.test.ts`.

`zmxTerminal(o: { bin: string; dir: string; agtermctl?: string; opener?: string; submitDelayMs?: number }): Terminal`.
Every call runs `bin` with `env: { ...process.env, ZMX_DIR: dir }` through a `run()` like
`agterm.ts`'s (stdin error listener included). Session ids handed to flowd are `zmx:<name>`; strip
the prefix before calling zmx.

- `spawn`: name = `flows-${o.name}` with `[^A-Za-z0-9._-]` → `-` (daemon passes `<process>-<n>-<role>`);
  `mkdir -p dir`; run `["run", name, "-d", "exec", "env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "/bin/zsh", "-lc", <inner>]`
  with `cwd: o.cwd`, where `<inner>` is what `spawnCommand` puts inside its `zsh -lc` today (the
  spawn plus the quoted first line) — add a helper in `agterm.ts` that returns just that inner string
  and have `spawnCommand` use it. Then `["set", name, ...labels]` (labels passed by the daemon as
  `env`-like map is fine, or a separate `labels` field — keep it simple). Return `zmx:${name}`.
- `type`: `type` with the text (trailing newline stripped), pause `submitDelayMs` (default 500), then
  `type` with `\r` — same as `realAgterm.type`.
- `press`: `["send", name, keys]`. (Check in the patch whether `send` takes the bytes as an argument
  or on stdin; use what it takes.)
- `text`: `["screen", name]`, drop the header line.
- `userInput`: parse the `screen` header's cursor column; `> EMPTY_INPUT_COLUMN` → true; errors → false.
- `tree`: parse `list`; `no sessions found` → `[]`; each → `{ id: "zmx:"+name, name, cwd, workspace: "" }`.
- `focus`: `agtermctl session new --command "env ZMX_DIR=<dir> <bin> attach <name>" --name <name>`
  then `opener -a agterm` (as `realAgterm.focus` does); if `agtermctl` fails, throw an error whose
  message is the attach command, so the UI shows what to run.

**Tests** use a fake `zmx` (a shell script in a temp dir that appends `$ZMX_DIR|$PWD|$*|<stdin>` to a
log and prints canned output per subcommand, like `test/agterm.test.ts`'s fake `agtermctl`):
spawn argv/env/cwd/labels and the returned id; type sends text then `\r`; text drops the header;
userInput true/false from the header; tree parses two sessions and the empty message; a failing
`agtermctl` makes focus throw the attach command.

### Task 3: `terminal:` on a process

**Files:** `src/types.ts` (`Process.terminal: "agterm" | "zmx"`), `src/defs.ts` (`PROCESS_KEYS`,
validation `terminal must be agterm or zmx`, default `agterm`), `test/defs.test.ts`,
`docs/processes.md` (Process keys row; validation list).

### Task 4: the daemon routes by session

**Files:** `src/daemon.ts`, `src/main.ts`, `src/http.ts`, `test/daemon.test.ts`, `test/daemon-helpers.ts`.

- `FlowdOptions.zmx?: Terminal`; `termOf(session) = session.startsWith("zmx:") ? this.zmx : this.agterm`
  (a `zmx:` session without `o.zmx` → error "zmx is not configured").
- `spawnFor`: `p.terminal === "zmx"` → `this.zmx.spawn({ ..., name: `${run.process}-${n}-${role}`,
  env: { FLOW_SESSION: <the id it will get> }, labels run=<process>.<n> role=<role> })`. The id is
  known before spawning (`zmx:flows-…`), so pass it in `env`. agterm spawns unchanged.
- Every other `this.agterm.*` call goes through `termOf(session)`: `doFlush` typing, `userInput`
  (replaces `userInSession`), `answerTrust` (`text`/`press`), `unboundSession` (search the terminal
  the process uses).
- `reconcileSessions` and a new tick check: for sessions held by open runs that start with `zmx:`,
  one `zmx.tree()`; missing → submit `agterm.closed` (keep the existing internal event type; it means
  "session closed" whatever the terminal). Don't call `zmx.tree()` when no run holds a zmx session.
- `main.ts`: build the zmx terminal: `bin` = `FLOWS_ZMX` || `zmx` on PATH ||
  `/Applications/agterm.app/Contents/MacOS/zmx` (first that exists); `dir` = `FLOWS_ZMX_DIR` ||
  `~/.local/state/flows/zmx`.
- `http.ts`: `/api/sessions` returns agterm's and (if any run holds one) zmx's; focus routes by id.
- **Tests** with a second `FakeAgterm` instance as `zmx` (it already records calls): a
  `terminal: zmx` process spawns through it with `FLOW_SESSION` in env and an id starting `zmx:`;
  an agterm process still spawns through agterm; typing and the draft check go to the right fake;
  a zmx session gone from the fake's tree closes the role.

### Task 5: turn signals from Claude Code hooks

**Files:** `src/cli.ts`, `src/http.ts`, `src/daemon.ts`, `src/install.ts`, `test/cli.test.ts`,
`test/daemon.test.ts`, `test/install.test.ts`.

- `flow claude-hook <event>`: session = `FLOW_SESSION || AGTERM_SESSION_ID`. For events other than
  `compacted`, read stdin as JSON (Claude Code passes `session_id`, and `source` for SessionStart; a
  bad or empty stdin is fine: send without them) and exit 0 at once without a `FLOW_SESSION` (only
  zmx sessions use this path). Post `{event, session, claude, source}` to `/claude`; never print,
  2 s limit, exit 0 — like `agterm-hook`.
- `/claude`: `compacted` as today; `start`/`active`/`completed`/`blocked` → submit `claude.status`.
- Daemon `claude.status`: ignore unless the session starts with `zmx:` and an open run holds it.
  Keep `claudeOf = new Map<session, claudeSessionId>()` (in memory; after a flowd restart the first
  event sets it). `start` with source `startup` sets it only when unset; with `clear`/`compact`/
  `resume` it replaces it. Other events: unset → set from this event; different id → ignore (a
  nested `claude -p`). Then handle exactly like `agterm.status` with that status (`start` is
  not a status: it only records the id).
- `install.ts`: beside `PostCompact`, add flows' entries (same replace-own-entry logic):
  `SessionStart` → `claude-hook start`, `UserPromptSubmit` and `PostToolUse` → `claude-hook active`,
  `Stop` → `claude-hook completed`, `Notification` with `matcher: "permission_prompt"` →
  `claude-hook blocked`. Back up settings once as today.
- **Tests:** CLI posts `FLOW_SESSION` over `AGTERM_SESSION_ID` and stays silent without it; daemon:
  `completed` from the agent's id ends the turn (reminder armed), the same from another id after a
  `start` is ignored, `start` with `clear` moves the id; agterm sessions ignore `claude.status`;
  install writes all entries once and is idempotent.

### Task 6: `flow` finds the session by `FLOW_SESSION`

**Files:** `src/cli.ts`, `test/cli.test.ts` (the helper already blanks `AGTERM_SESSION_ID`; also
blank `FLOW_SESSION` there). `session = FLOW_SESSION || AGTERM_SESSION_ID`.

### Task 7: UI and docs

- UI: the terminal button already calls focus; on error show the message (the attach command) where
  errors show today. No other UI change.
- Docs: `docs/processes.md` (`terminal`, how a zmx session is named, what `focus` does),
  `docs/concepts.md` (Sessions and roles: two terminals, `FLOW_SESSION`, turn signals),
  `docs/architecture.md` (map: `src/zmx.ts`, the Terminal interface), `docs/cli.md` (`claude-hook`
  events, env `FLOW_SESSION`, `FLOWS_ZMX`, `FLOWS_ZMX_DIR`), `docs/troubleshooting.md` (a zmx
  session: `ZMX_DIR=~/.local/state/flows/zmx zmx list`, attach), `README.md` if it says "agterm
  only", `skills/flow-author/SKILL.md` (a row: `terminal: zmx`), `CLAUDE.md` map (`src/zmx.ts`).

### Task 8: by hand, with the user's go

Ask the user first: it runs `flow install` (hooks into `~/.claude/settings.json`) and spawns a real
Claude. Then: `examples/` `demo` copied as a `terminal: zmx` process in `~/.config/flows`, `flow start`;
check the first prompt arrives, the trust dialog is answered (a fresh folder), `flow done` moves on,
the next line is typed and submitted, a turn end without a report gets a reminder, the UI terminal
button opens the session in agterm. Report what worked and what did not; fix in new commits.
