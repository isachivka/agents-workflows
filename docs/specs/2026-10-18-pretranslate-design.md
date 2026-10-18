# Translating steps ahead of time

## Problem

A step's prompt is translated on request (`POST /api/steps/:id/translate`, see
[2026-10-18-read-a-process-design.md](2026-10-18-read-a-process-design.md)): the first click on a
step waits about 12 seconds. Steps change rarely, and flowd sits idle most of the time.

## Decisions

- flowd translates every valid step's prompt in the background, through the same `Translator` and
  cache, so a click finds the translation ready. Into each language of `FlowdOptions.pretranslate`
  (in `main.ts`: `FLOWS_PRETRANSLATE`, comma-separated, default `ru`; empty turns it off; unset in
  tests). A prompt already mostly in that language's script (Cyrillic for `ru`) is skipped.
- When: 2 minutes after start (runs resuming come first), and 1 minute after the last change of a
  step file (the UI editor saves often). A later change restarts that minute.
- Only when the translator is idle: one step at a time, and only while no requested translation is
  running or waiting. A click always goes first.
- A pass stops at its first failure (codex not logged in, a model gone) and logs it once; the next
  change or restart tries again.
- After a pass with nothing left to translate, cached files no current prompt uses are deleted.
- Same timeout and process-group kill as a requested translation; `close()` ends it.

## Testing

`test/pretranslate.test.ts` with the fake translator: a pass fills the cache and skips a Russian
prompt; a requested translation afterwards starts no translator; an edited step is translated
anew and its old file removed; nothing runs without `pretranslate`; a failing translator stops the
pass after one try.
