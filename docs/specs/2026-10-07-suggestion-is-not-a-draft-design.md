# A prompt suggestion is not a draft

Status: proposed 2026-10-07 (bug from the user's live run). Awaiting the user's approval.

## Problem

`docs/specs/2026-10-07-no-typing-over-the-user-design.md` made flowd hold a line while the
session's input box holds a draft, read from the screen text. After a turn Claude Code draws a
greyed **suggestion** in the empty input box (`❯ run the tests again …`). In `agtermctl session
text` it looks exactly like typed text, so flowd held the next step's line for 30+ minutes; it
would do so after almost every turn.

## Decision

Decide "the user is typing" by the **caret**, not the screen text: `agtermctl surface cursor
--target <primary surface id>` gives the caret's column, and at an empty input box (`❯ ` in
Claude Code, `› ` in Codex) it is 2 whatever suggestion is drawn. Past 2 there is real text: hold
the line. At 2, or when the caret cannot be read (no surface, a hidden surface, an error), type
as before. The surface id comes from `tree --json` (`surfaces[]`, kind `left`); the session id is
not a surface id. A caret moved back over existing text reads as 2 — accepted, as peer-chat does.

The overlay check stays. The screen-text parser (`composerDraft`) is removed.

## Testing

Adapter: `cursorColumn(surface)` parses the column and passes the surface id; `tree()` carries
the primary surface id. Daemon: column 2 with a suggestion on screen → typed; column > 2 → held,
then typed once it is back to 2; an unreadable caret → typed; overlay → held. Docs: the delivery
rule in `concepts.md` and the troubleshooting entry say "caret past the prompt", not "text in the
input box".
