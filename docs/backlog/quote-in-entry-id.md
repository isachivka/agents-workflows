---
worth: low
where: src/defs.ts
added: 2026-10-04
---
Entry ids are not checked against the name rule, so an id may contain a quote or a space. The id goes into the nudge line and so into the spawn command line; it is quoted, and quoting held on a live run, but only backticks were tried. Fix: validate entry ids with the same rule as step ids.
