# Reminders must not land on top of the user

Status: approved 2026-10-07 by the user ("bug! short spec/plan/fix").

## Problem

During a review step the user was typing a message to the agent in its session. flowd typed a
reminder into the same input box; the reminder's Enter sent the user's half-written message and
the reminder as one prompt, and the agent re-opened the review viewer it had just closed.

The event log shows why the reminder fired at all: the agent's turn had **not** ended. The
session went `active` → `blocked` (the agent's viewer was up) → `idle`, and flowd took that
`idle` for a turn end and armed the 30 s reminder.

In agterm, `idle` is never "the agent finished": Claude's and Codex's hooks report the end of a
turn as `completed` (Codex reports `blocked` when the turn ends with a question). `idle` only
appears when the status is cleared — agterm's auto-reset on the user's first keystroke in the
session, or an agent session starting. Treating it as a turn end both fires false reminders and
fires them exactly when the user is at the keyboard.

## Decisions

1. **Only `completed` ends a turn.** It arms the reminder and parks a declared `flow wait`.
   `idle` changes nothing for a step. (A wait sent while the session is `idle` or `completed` still
   parks at once: the turn is over either way.)
2. **flowd does not type over the user.** Before typing into a session, flowd defers the line when:
   - an overlay is open in that session (agterm tree `overlay: true`), or
   - the session's input box holds a draft: the screen's last region between two horizontal rules
     (Claude Code's and Codex's composer) has text after the prompt mark.
   The line stays queued and is retried on the next flush (every second). If the session's tree
   entry or text cannot be read, flowd types as before.

## Testing

Engine: `idle` after `active` arms no reminder and does not park a wait; `completed` still does.
Daemon: a pending line is not typed while the session has an overlay or a draft, and is typed once
both are gone. A composer parser test on real screens: empty composer, a draft, a multi-line
draft, a screen without rules. Existing tests that used `idle` as a turn end switch to
`completed`. Docs: `concepts.md` (what ends a turn; delivery never over a draft or overlay),
`troubleshooting.md` (a line that waits because of a draft).
