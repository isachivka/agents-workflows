---
worth: low
where: ui/app.js StepPanel (Esc, ×)
added: 2026-10-18
---

Esc and × navigate to the process page with a new history entry, so browser Back after closing
reopens the panel.

Fix: when the previous history entry is the process page, use `history.back()`; otherwise
`location.replace` to the process page.
