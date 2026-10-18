# Reading a process in the UI

## Problem

Processes grew: nested runs (`inner`), a second agent beside the first (`beside`), Codex roles,
shell entries, pauses, `do: type`, `hold`, timeouts, `retries`, step skills, per-role folders and
session names. The process page still shows only a role chip, the step's summary and the failure
branch for each entry. On a real PR process nothing says that one entry waits for a review and repeats up to 50
times, that the next waits for the merge, that two entries hold a shared test desk, or how long
a step may take. Roles do not say whether they are Claude or Codex or which pane they run in. Nobody can
debug a process, or ask an agent to fix one, from that page.

The user reads English slowly. A step's prompt is in English and the UI shows it raw.

## Goals

- Read how a process is built from its page: who does each entry, what it waits for, what
  happens on failure, its limits, and where its text lives.
- Click a step to read everything about it in a side panel, its prompt included.
- Translate a step's prompt into the UI language with one button, through a local Codex model.

## Non-goals

- An editor or constructor (the existing editors stay as they are).
- Translating summaries, descriptions or anything other than a step's prompt.
- Automatic translation.

## Decisions

### Process page

- Every entry card is a button. Clicking it opens the step panel and highlights the card. The
  panel has its own address, `#/process/<name>/step/<entry id>`, so it can be linked and the
  browser's back closes it.
- Each card carries short badges for what it does not say today, in plain words: waits for
  (a review, the merge, checks — the event's phrase), holds `<name>`, at most `<duration>`, up to
  `<n>` tries. Nothing new when the entry has none of them.
- "Who takes part": each role says its agent (Claude, Codex, or "a program" for anything else,
  from `agentOf(spawn)`), "in the right half beside `<role>`" for `beside`, and its folder when it
  differs from the process folder.
- An `inner` entry reads "Here agent `<role>` runs another process — chosen when the run starts".

### Step panel

- Wide screens: a sticky panel to the right of the entry list, scrolling on its own. Below
  960 px: a full-screen sheet. Esc or the back arrow closes it; ‹ › go to the previous and next
  entry.
- Head: entry number, who does it (role chip and agent kind, or You, or flows), the summary.
- "How it works", one plain line each, only those that apply: waits for (event phrase and its
  `with` conditions), on failure (the existing branch lines), then goes to, at most (timeout),
  tries (retries), holds, skills.
- Entries without a prompt show what they do: a shell entry its command and folder, `do: type`
  its text, a pause its length, `do: clear`/`compact` a sentence.
- "What it is told" (agent and human steps): the step's prompt as written, in a readable
  monospace block, with **Translate into Russian** when the UI language is RU. While it works:
  "Translating… about 10 seconds". Done: the translation replaces the text and a "Translation /
  Original" switch goes back. A failure shows under the button with what to do.
- "Where it lives": the step file and the process file as full paths, each with a Copy button —
  to paste to an agent with "fix this step". Below: where else the step is used, and "Edit text"
  to the existing editor.
- The run page's "What it is told" fold gets the same Translate button. It translates the step's
  text (with `{{…}}` placeholders), not the filled-in prompt.

### API

- `GET /api/processes` adds fields; none change:
  - per process: `path` (the YAML file), `workspace`, `terminal`, `roleDefs`:
    `[{ name, agent: "claude" | "codex" | "other", beside, cwd }]`;
  - per entry: `timeoutMs`, `retries`, `hold`, `with` (a plugin action's arguments, as in the
    definition), `waitWith` and `waitWhere` (the wait's conditions; `waitFor` stays the event type
    string), `text` (`do: type`), `cwd` (shell), `skills` (from the step), `inner` as `kind`.
    Paths are shown with `~` for the home directory.
- `GET /api/steps/:id` adds `path` (the step file).
- `POST /api/steps/:id/translate` with `{ lang: "ru" }` returns `{ text }`:
  - flowd reads the step's body itself; the browser never sends text to translate;
  - it runs the translator as an argv with the body on stdin and a fixed instruction as the last
    argument (translate into `<lang>`; keep code, commands, `{{placeholders}}`, URLs and
    Markdown; output only the translation). Default: `zsh -lc 'exec "$@"' zsh codex exec -m
    gpt-6-luna --sandbox read-only --ephemeral --skip-git-repo-check -c
    model_reasoning_effort=low`, so the login shell finds `codex` and nothing is quoted into a
    shell string; in a temporary folder, in its own process group. `FlowdOptions.translate`
    replaces the argv (tests and the preview default to a fake), `translateTimeoutMs` the
    2-minute limit;
  - on the time limit and on flowd's close the whole process group is killed: nothing outlives
    the request;
  - at most two translations run at once; more wait in line. Two requests for the same text share
    one run;
  - the result is cached in `<state dir>/translations/<sha256 of the argv, instruction and
    body>.txt`, written to a temp file and renamed; an edited step or a changed command is
    translated anew, an unchanged one comes back at once without starting anything;
  - a command that fails, prints nothing or runs out of time gives a 502 whose error says which,
    with the last lines of its stderr (no login, unknown model), and that the original is still
    readable;
  - unknown step: 404; `lang` other than `ru`/`en`: 400.
- The route goes through the existing Host/Origin/content-type guard like every POST.

## Testing

- `test/translate.test.ts`: with fake commands — the cache answers without starting a child,
  two concurrent requests for one text start one child, at most two run at once, an edited body
  runs again, a sleeping fake is killed with its group at the time limit (502 with the reason),
  close kills a running one, stderr lines reach the error.
- `test/http.test.ts`: the new process and step fields on a fixture home; the translate route
  (200, unknown step 404, bad lang 400, failure 502).
- `test/ui-text.test.ts`: the badge and "how it works" phrases for each entry kind and option,
  both languages, dictionary parity.
- `scripts/ui-preview.ts` seeds a process with every entry kind and option and a fake translator,
  so the panel can be checked on desktop and phone (320–430 px) without Codex.
- By hand on the real flowd: the largest PR process and a process with `beside` roles, a shell
  entry and `inner` read correctly; Translate on a long step returns Russian through Luna.
