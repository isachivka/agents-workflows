---
worth: low
where: src/install.ts
added: 2026-10-04
---
On re-install, `launchctl bootstrap` right after `bootout` can fail with "Bootstrap failed: 5: Input/output error" while the old job is still going away. The error is only printed, so the daemon may be left stopped. Fix: retry the bootstrap a few times, or use `launchctl kickstart -k` when the job is already loaded.
