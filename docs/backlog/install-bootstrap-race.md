---
worth: medium
where: src/install.ts
added: 2026-10-08
---
`flow install` runs `launchctl bootout` and then `bootstrap` at once. bootout returns before launchd
has torn the service down, so bootstrap can fail ("Command failed: launchctl bootstrap gui/<uid> …")
and flowd stays down until someone bootstraps it by hand (seen on a re-install on 2026-10-08).
Fix: after bootout, wait until `launchctl print gui/<uid>/local.flows` fails (a few hundred ms), or
retry bootstrap a few times with a short pause.
