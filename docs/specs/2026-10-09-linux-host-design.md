# flowd on a Linux host

**Status: draft, not approved.**

## Problem

flowd and its agents run only on a Mac: `flow install` writes a launchd agent and agterm hooks,
agents default to agterm, shell steps and spawns call `/bin/zsh`, and the zmx flowd needs is the
one inside `/Applications/agterm.app`. A Linux server (a VPS) could run the agents around the clock,
with the person reaching them through chat or the UI rather than a terminal.

A spike (2026-10-09, Docker, Debian and `node:24`) answered the open questions:

- agterm's patched zmx builds for Linux: zig 0.16, zmx 0.8.1 (`8bab1f0`) with agterm's patches and
  its pinned ghostty, `-Dtarget=x86_64-linux-musl` and `aarch64-linux-musl` from one container in
  about four minutes; static binaries of about 16 MB; agterm's own `check.py` passes.
- The suite passes on Linux (the one failure was a real bug, fixed: shell steps now run in their
  own process group).
- flowd drove a `terminal: zmx` run to `done` on Linux with a fake agent. Without Claude Code's hooks
  no turn is ever reported, so a step longer than two minutes stops as "has not started".

## Goals

- `flow install` on Linux sets flowd up as a systemd user service, with the Claude Code hooks and
  skill links, and nothing macOS-specific.
- On Linux a process runs its agents in zmx without saying `terminal: zmx`.
- Nothing assumes zsh, agterm or `/Applications`.
- A documented, repeatable way to get the patched zmx onto a Linux host.

## Non-goals (their own specs)

- Reaching the UI from outside the host, logins, roles. flowd keeps listening on `127.0.0.1`;
  until a spec adds authentication, the way in is an SSH tunnel or an authenticating proxy, never
  `FLOWD_HOST=0.0.0.0` on a public machine.
- Chat (Slack), the guard model, Jira.
- Provisioning the host (users, Node, Claude login, gh auth, git keys, VPN).

## Decisions

**Platform default for `terminal`.** A process without `terminal:` uses `agterm` on macOS and
`zmx` elsewhere. An explicit value wins. `flow check` reports `terminal: agterm` on Linux as an
error ("agterm runs only on macOS").

**Shell.** One resolver for the login shell flowd uses for spawns (agterm and zmx) and `sh:` steps:
`FLOWS_SHELL`, else `/bin/zsh` if it exists, else `/bin/bash`; always `-lc`. The three hard-coded
`/bin/zsh` go through it. Step authors who rely on zsh syntax say so with `FLOWS_SHELL`.

**zmx binary.** Lookup stays `FLOWS_ZMX`, then `zmx` on `PATH`, then agterm's bundled one (macOS
only). `scripts/build-zmx.sh` (from the spike) builds the patched zmx for both Linux targets in a
container: pinned zig, zmx and ghostty commits, agterm's patch files fetched at a pinned agterm
commit. Its output goes to `~/.local/bin/zmx` on the host. `docs/troubleshooting.md` explains how to
check it (`zmx version` lists `type` and `screen`).

**Install on Linux** (`src/install.ts`, chosen by `process.platform`):

| What | Where |
|---|---|
| link to `bin/flow` | `~/.local/bin/flow` (as today) |
| systemd user unit `flowd.service`: `ExecStart=<node> <repo>/src/cli.ts daemon`, `Restart=always`, `Environment=` for `PATH`, `FLOWD_HOST` (kept across re-installs as on macOS), `FLOWS_ZMX` when set | `~/.config/systemd/user/flowd.service`; then `systemctl --user daemon-reload` and `enable --now` (restart when already running) |
| linger, so the service runs without a login session | `loginctl enable-linger $USER`; when refused, print the command to run with sudo |
| Claude Code hooks, skill links | as today |
| agterm `hooks.conf` | skipped when `agtermctl` is not found (on any platform) |

`FLOWS_SYSTEMCTL` and `FLOWS_LOGINCTL` name the binaries, so tests use fakes as they do for
`launchctl`. Logs: the journal (`journalctl --user -u flowd`), and the same `flowd.log` file flowd
writes today.

**No agterm.** `GET /api/sessions` lists zmx sessions and skips agterm when `agtermctl` is missing
(today it throws). Session reconciliation logs the missing agterm once. The terminal button on a zmx
session without agterm answers with the attach command, as it already does when agterm fails:
`ZMX_DIR=… zmx attach <name>`, to run over SSH.

**Hints name the platform's service manager.** "flowd is not running" says
`systemctl --user restart flowd` on Linux; docs that give `/Applications/…/zmx` say `zmx` on Linux.

**Turn tracking needs the hooks.** On Linux every agent is in zmx, and zmx sessions learn turns only
from Claude Code's hooks. `flow install` already writes them; `flow check` warns when a zmx process
exists and `~/.claude/settings.json` lacks flows' hooks.

**A spawned agent that exits at once.** If the session is gone before `zmx set` labels it, the
spawn counts as done and the closed session is noticed as usual, instead of failing and spawning
again (up to three agents today).

## Testing

- Unit: the terminal default by platform (platform injected); the shell resolver; Linux install with
  fake `systemctl`/`loginctl` (unit text, enable/restart, linger refused prints the command, FLOWD_HOST
  kept, agterm skipped without `agtermctl`); `/api/sessions` without agterm; the early-exit spawn.
- The suite runs in a `node:24` container (documented command), as the spike did.
- By hand, with the user's go, on the real host: build and install zmx, `flow install`, a demo
  process with a real Claude agent: first prompt, trust dialog, `flow done`, the next line, a reminder.
