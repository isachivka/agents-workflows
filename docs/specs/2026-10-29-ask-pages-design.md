# Asking the person on a published page

## Problem

A step that needs the person to choose (tick the topics to make, pick an option) can only ask at the Mac:
an agterm overlay with a form. The person often reads the run's messenger on the phone, where reports
already arrive as links (`flow say --file`, `flow publish`), but a report is read-only: there is nowhere
to send ticks back, and the run would not learn of them.

## Goals

- An agent publishes a question page and waits; the person answers it on any device through the link in
  the run's conversation; the answer reaches that agent as a line in its terminal.
- The page is written as the agterm overlay's question fragment is, and the agent gets the same JSON, so
  one fragment works in both places.

## Non-goals

- Logins on the page: the link is the key, as for reports.
- Live collaboration, several people answering one page, uploads.

## Decisions

- **`flow ask FILE --note T`**, from the agent's session (`--run` elsewhere). `FILE` is an HTML fragment
  (no `<html>`/`<head>`): named inputs; `choice` radios or checkboxes; a `note` textarea if wanted (one
  is added when there is none). flowd wraps it into a page: the fragment inside a form, a Send button, a
  "sent ✓" state, a little script. It publishes the page as a report (the same unguessable link, the
  same expiry), records the question (token, run, entry, role), posts `T` with the link in the run's
  conversation (as `flow say` would, unless the process has `notify: false`), puts the step into
  `flow wait --human` with the note `T · <link>`, and prints the link. The agent then ends its turn.
- **The answer.** Send POSTs the form as JSON to `/r/<token>/answer` on the reports listener:
  `choice` always a list, any other name a string (a list when several inputs share it), as the overlay
  returns it. flowd keeps it and types into the asking role, through the outbox (a sleeping role wakes):
  `▶ flow: the person answered your question (<link>): {"choice": [...], "note": "…"}`, with a line
  saying they read the messenger, not the terminal. The wait ends with that turn, as with a typed answer.
- **Again.** The page GETs `/r/<token>/answer` on load: a sent answer comes back ticked, with "sent ✓".
  Ticks are saved as a draft while the person goes (`POST /r/<token>/draft`, the same limits), so a page
  closed before Send comes back as it was left, on any device; the agent hears nothing of drafts, and a
  draft after the run moved on is refused like a late send. The person may send again while the entry that asked is
  the run's current one: the agent gets the new answer, marked as a change. Once the run has moved on or
  ended, a send is refused with 410 and the page says the question is closed.
- **The reports listener** gets this one write, and only it: POST to `/r/<32 hex>/answer` (and `/draft`) for a token
  that is a question, `content-type: application/json`, at most 64 KB, no CORS headers; everything else
  stays 404, as now. The UI listener and its Host/Origin checks are untouched.
- **Without a reports listener** (`FLOWS_REPORTS_URL` unset) `flow ask` is refused and says to set it,
  or to ask in the agterm overlay. **Without a messenger** the page still works: the link is printed and
  shown in the run's waiting note in the UI.

## Testing

reports: the answer route takes a JSON body for a question token, refuses another method or path, a
non-question token, a wrong content type, an oversized body; GET returns the stored answer. daemon:
`flow ask` publishes, posts to the conversation, sets the human wait with the link, records the question;
an answer is typed into the asking role (a sleeping one wakes); a second answer is marked as a change;
an answer after the entry is done gets 410; no listener refuses. cli: `flow ask` prints the link. Docs:
cli.md, http-api.md, processes.md, skills/flow and flow-author.
