---
worth: medium
where: src/agterm.ts
added: 2026-10-04
---
Text and Enter are typed 500 ms apart and nothing checks that the Enter landed. A slower terminal can miss it, and the step then sits unsubmitted (see silent-submit-stuck-step). Fix: read the screen back with `agtermctl session text` and retry the Enter until the composer is empty.
