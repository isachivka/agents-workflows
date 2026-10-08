---
worth: low
where: src/main.ts zmxBin
added: 2026-10-08
---
flowd takes `zmx` from `PATH` before agterm's bundled build, and the launchd PATH includes
`/opt/homebrew/bin`. An upstream zmx from Homebrew lacks the `type` and `screen` commands, so every
line typed into a zmx session fails and the session is taken as closed. Fix: prefer the agterm
bundle, or probe the found binary for `screen` and skip it otherwise.
