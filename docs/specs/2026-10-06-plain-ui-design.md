# A web UI anyone can follow: see what runs, see what needs you, act

Status: design, awaiting approval.
Mockups: a private Claude Design canvas — boards Main, Run, RunNeedsYou, Process, Brand.

## Problem

The web UI mirrors the engine. A run row reads `pr-loop#1 it.1 running ci-fix active ·
waiting: CI: …`; the run page opens with a 30-line rendered prompt, a blue primary `done`
button that overrides the agent, a JSON event table and a `rebind to…` select. To use it you have
to know what an entry, a role, an iteration, a detour and `needs-human` are.

Steps are worse: the process page shows each step as a row of ten form fields without its text,
and the step page shows the text without saying which process it belongs to, where, or what comes
before and after. Neither answers "what does this process do?".

The person at the screen wants three answers, fast: is anything waiting for me, what is
everything else doing, and what do I press.

## Goals

1. Someone who has never read the docs can open the UI and tell, within seconds, which runs wait
   for them and what each wants.
2. Every state of a run is described in plain words, built from the step summaries the author
   already writes; no engine terms (`entry`, `iteration`, `needs-human`, `vars`, `rebind`) on the
   primary screens.
3. When a run stops for a human, the page explains why and offers the sensible choices with what
   each one does; rare and risky overrides are one click further away.
4. A process reads top to bottom as a story — who does what, where it branches, where it waits —
   with each step's text expandable in place. The Steps tab leaves the navigation.
5. The interface speaks Russian or English, switchable; the choice is remembered.
6. The tab tells you from afar: a favicon and title that change when something waits for you,
   plus a full icon set (16/32/48, 180, 192/512) and a web manifest.

## Non-goals

- The editors. Making process and step authoring approachable is the next sub-project with its
  own spec. This one keeps the current editors working, reachable from "Edit", restyled only by
  the shared CSS.
- Translating author-written text: step summaries, prompts, agent notes and `reason` strings stay
  as written (today in English).
- Desktop notifications, sounds, a phone layout beyond "does not break" (flowd listens on
  127.0.0.1).
- New engine behaviour. Every action maps to an endpoint that exists today.

## Decisions

| Question | Decision |
|---|---|
| Scope | Follow and react only; the constructor is a separate sub-project. |
| Main object | The process; steps are shown inside it. `#/steps` stays reachable (from Settings and from a step's "Edit text" link) but leaves the nav. |
| Language | RU/EN switch, a string dictionary in `ui/text.js`. Default from `navigator.language` (`ru*` → RU, else EN), stored in `localStorage` (`flows.lang`). |
| Look | One small system, from the mockups: warm off-white ground, ink text, blue `#2747a8` for "working", orange `#d9801a` for "needs you", green for done. Light and dark. |
| Typeface | Onest (OFL, Cyrillic + Latin) vendored as two woff2 files, *if a human says yes* — see [Needs a yes](#needs-a-yes). Fallback: the system stack. Monospace stays `ui-monospace`. |
| Routes | Hash routes keep their names (`#/runs`, `#/run/:id`, `#/processes`, `#/process/:name`) so old links work. New: `#/process/:name/edit` (the current editor), `#/settings`. |

## Words

The dictionary holds every UI string in both languages. The glossary it follows:

| Engine | RU | EN |
|---|---|---|
| run `pr-loop#4` | запуск 4 (процесса pr-loop) | run 4 (of pr-loop) |
| iteration | круг | round |
| `needsYou` | ждёт тебя | waiting for you |
| `running` / `paused` / `done` / `stopped` | работает / на паузе / готово / остановлен | running / paused / finished / stopped |
| role | агент (по имени роли: dev, lead) | agent (by role name) |
| `human` role | ты | you |
| vars | данные запуска | run details |
| events | что происходило / вся история | what happened / full history |
| session | терминал агента | agent terminal |
| retry | попробовать снова | try again |
| skip | пропустить шаг | skip this step |
| done (human override of an agent step) | считать шаг сделанным | mark the step finished |
| done (a human step) | готово | done |
| goto | перейти к шагу… | jump to step… |
| rebind | поручить шаг другому терминалу… | hand to another terminal… |
| respawn | перезапустить агента | restart the agent |
| `do: clear` / `compact` / `type` | {role} начинает с чистого листа / сжимает контекст / flows печатает в терминал {role} | {role} starts fresh / compacts its context / flows types into {role}'s terminal |
| wait on `gh.checks` / `gh.merged` / `gh.review` / `gh.opened` / `gh.ci` / `signal.X` / other | проверки GitHub / мёрдж PR / ревью PR / открытие PR / CI на GitHub / сигнал X / the raw type | GitHub checks / the PR merge / a PR review / the PR opening / GitHub CI / signal X / the raw type |

## Screens

All screens share a header: the flows mark, three tabs — **Now** (`#/runs`), **Processes**,
**Settings** — and the RU/EN switch. Buttons are at least 44 px tall; one primary button per card.

### Now (`#/runs`, board Main)

- A heading and one sentence: "Two runs wait for you. Two more work on their own." / "Everything is
  calm." A quiet "Start a process…" button.
- **Waiting for you** — one orange card per `needsYou` run, oldest wait first: a tag (Your step /
  Stopped / Agent asks), `process · run N`, how long it has waited, a title and a sentence from
  `describeRun` (below), and the actions that fit (below). A link-valued var named `pr` (or the
  first URL var) becomes the primary "Open PR on GitHub" when the step is a human one.
- **Working on their own** — a grid of cards: the plain-language current state, a segmented
  progress bar (done / current / pending over the non-detour entries), "step 4 of 8 · 12 min",
  "Details", and "Agent terminal" when the current role has a session.
- **Finished today** — compact rows: status, run, the last note, "2 h ago". Older finished runs
  behind "Show older".
- Empty state: "Nothing is running. Start a process" with the button.

### A run (`#/run/:id`, boards Run and RunNeedsYou)

- Back link, `process · run N`, status pill, the process description with a link to the process
  page, "round 4 · started 09:12". Pause/Resume and Stop (Stop keeps its confirm).
- **When the run waits for you**, an orange panel comes first, shaped by the situation:

  | Situation | Headline | Choices (first = primary) |
  |---|---|---|
  | `needs-human`, current entry `failed` | "Step "{summary}" did not work out" + the reason quoted, attempts | Try again · Skip this step (asks why, inline) · Open the agent's terminal |
  | `needs-human`, other reason (session closed, template error, start watchdog) | "The run stopped and waits for you" + the reason quoted | Try again · Restart the agent (when a role session is involved) · Open terminal |
  | human step active or waiting | the step's summary; its prompt text shown (it is written for the human) | Done (primary; hidden while the step waits for an event — then "closes by itself when {event phrase} arrives") · the PR link when present |
  | agent wait with `human: true` | "{role} waits for you" + the note | Open the agent's terminal |

  Each choice carries one line on what it does. "Other options" folds jump to step…, hand to
  another terminal…, mark the step finished. "Stop the run" sits apart, in red text.
- **How it goes** — the plan as a vertical timeline: done entries collapse to one line with the
  time, duration and note; the current entry is an open card (what it does, how long, the agent's
  latest wait note if any, "Open {role}'s terminal", folded "What the agent was told" with the
  rendered prompt, folded "Step in by hand" with mark finished / start again / skip); upcoming
  entries are faint, with their branch line ("if the review fails → back to step 4"). Detours show
  only when entered.
- **Side column**: Run details (vars as label/value, URLs as links, long values wrap), Agents
  (role, live status, terminal link; restart and hand-over folded), What happened (the last five
  events as sentences, below), then "Full history with technical details" which unfolds the old
  event table.

Events as sentences (others are left out of the short list, all appear in the full history):
`entry.delivered` → "{role} got the task"; `flow.step.done` → "{role} finished: "{note}"";
`flow.step.failed` → "{role} failed: "{note}""; plugin events of a wait → "{event phrase}:
{outcome}"; `run.set` → "run details updated"; run start → "round N began".

### A process (`#/process/:name`, board Process)

Read-only. Name, description, fact chips (repeats in rounds · up to N runs at once · started by
hand / on {trigger} · works in {cwd}), Start and a quiet Edit (→ `#/process/:name/edit`). Open
runs as chips with their status. Who takes part: each role, plus "you" when a human step exists.
**How it goes**: numbered entries — icon for agent / you / wait / session action, the role, the
step summary, a branch line from `on_fail.goto`, `after.goto` and `on_fail: retry`, a "only when
needed" tag for detours — each agent or human step folds out its template text with "Edit text"
(→ `#/step/:id`) and "also used in …". A closing line when `repeat`: "Then it starts again with
a new round."

### Processes (`#/processes`)

Cards instead of a table: name, description, "N steps", triggers in words, open runs with status,
Start. Invalid processes show their errors in plain red text and no Start. "New process" moves to
the bottom as a quiet link (it opens the existing editor).

### Start (`#/start/:name`)

Same form, in words: per role "Start a new terminal (recommended)" or one of the open terminals.

### Settings (`#/settings`)

Plugins (today's table), Restart flows, a link to all steps (`#/steps`), the language switch
repeated.

### Errors

`alert()` goes away: a failed action shows its error inline above the actions that caused it,
and stays until the next action. `confirm()` stays for Stop and for deletions.

## The tab: icon and title

- `ui/icons/`: `favicon.svg` (the mark: ink rounded square, a curve between two dots, the far dot
  blue), `favicon-attention.svg` (the far dot replaced by a large orange dot), `favicon.ico`
  (16/32/48), `apple-touch-icon.png` (180, full-bleed), `icon-192.png`, `icon-512.png`,
  `icon-maskable-512.png`. PNG and ICO files are generated once from the SVGs with
  `rsvg-convert` and committed; `scripts/icons.sh` regenerates them (a dev tool on the
  maintainer's machine, not a runtime dependency).
- `ui/manifest.webmanifest`: name, short name, icons, `theme_color`, `background_color`,
  `display: standalone`.
- `index.html`: `lang` follows the switch, description, `theme-color` for light and dark,
  `color-scheme`, all icon links.
- `document.title` is live: "(2) Waiting for you · flows" when anything waits; on a run page
  "pr-loop · run 4 · flows"; otherwise "{Page} · flows". The favicon swaps to the attention
  variant whenever the waiting count is above zero, on every page.
- `src/http.ts` gains content types for `.png`, `.ico`, `.webmanifest`, `.woff2`.

## API changes (additive)

- `RunSummary` gains `created` and `updated` (ms, from the `runs` table), and each `plan` item
  gains `summary` (the step's summary; `null` for actions and waits), `startedAt`, `note`,
  `onFail` (`"human" | "retry" | {goto}`) and `after` (`{goto}` or `null`).
- `GET /api/processes` entries gain `step`, `summary`, `do`, `onFail`, `after`; each process gains
  `maxRuns` and `cwd`.
- Nothing is removed or renamed; the CLI is untouched.

## Code

- `ui/text.js` — pure, no DOM: the RU/EN dictionary, `t(key, params)`, durations ("12 min" /
  "12 мин", "1 h 10 min"), event phrases, entry phrases, `describeRun(summary, lang)` →
  `{tone: "you" | "work" | "wait" | "calm", tag, title, detail}`, and `eventSentence(event, run)`.
  Everything the screens say about a run comes from here, so it is testable.
- `ui/editors.js` — `ProcessEditor`, `ProcessForm`, `EntryCards`, `Steps`, `StepEditor` moved out
  of `app.js` unchanged.
- `ui/app.js` — shell, router, data hooks, the new screens.
- `ui/style.css` — rewritten around the tokens; dark values under `prefers-color-scheme`.
- No build step, no new runtime dependency; Preact + htm stay vendored.

## Testing

- `test/ui-text.test.ts` (imports `ui/text.js`): both languages have the same keys and no empty
  strings; `describeRun` for each row of the situation table and for working / waiting on an
  event / agent wait / paused / done; durations at the boundaries (0, 59 s, 1 min, 59 min, 1 h,
  1 h 10 min, days); event phrases for known and unknown types; `eventSentence` for each mapped
  event and `null` for the rest.
- `test/http.test.ts`: the icons and the manifest are served with their content types;
  `index.html` links them.
- `test/daemon.test.ts`: `RunSummary` carries `created`, `updated` and the new plan fields;
  `GET /api/processes` carries the new entry fields.
- By hand, with agent-browser against a scratch `$FLOWS_HOME` (never the real one): Now, a working
  run, each needs-you situation, a process page, Settings — in RU and EN, light and dark, at
  1440 px and 390 px. Screenshots go with the last commit's description.

## Documentation

- `README.md`: the feature line (l. 25) and the demo walkthrough (l. 79: "The Runs page lists
  `demo#1` under "Needs you"").
- `docs/http-api.md`: the new fields, the static content types.
- `docs/architecture.md`: the `ui/` file list.
- "Needs you" → "Waiting for you" in `docs/cli.md`, `docs/concepts.md`, `docs/processes.md`.
- `examples/steps/changelog-approve.md`, `demo-approve.md`: "the done button" → "the Done
  button".
- `docs/processes.md` and `skills/flow-author/SKILL.md`: a step's `summary` is now the headline a
  person reads for that step, so write it as a plain sentence saying who does what ("The dev fixes
  red CI"), not a label.

## Needs a yes

- Vendoring the Onest font (two woff2 files, ~60 KB, SIL OFL) under `ui/vendor/fonts/` with its
  licence. It is an asset, not code, but CLAUDE.md asks for a human's yes on anything vendored.
  Without it the UI uses the system font.
