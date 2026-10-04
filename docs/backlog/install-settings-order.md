---
worth: medium
where: src/install.ts
added: 2026-10-04
---
`flow install` parses `~/.claude/settings.json` only after it has already rewritten the launchd plist and `hooks.conf`, and writes it in place. A malformed settings file aborts the install halfway; a crash mid-write corrupts it. Fix: read and parse every file first, then write each one atomically (temp file and rename).
