# Spawning a process's agents into their own agterm window

## Problem

`agtermctl session new` lands in the frontmost window. A factory process with several agents at a time
fills the window the person works in with sessions they never look at.

## Decisions

- A process key `window: <name>`. Its roles (a step's spawn, the host of a `beside` role, a restored
  conversation) spawn into the agterm window of that name with `session new --window <id>`; still
  `--no-select`, so focus never moves.
- The window: the open one with that name in `agtermctl window list`; else a new one,
  `window new <name> --minimized`, so it never comes in front. A closed window of that name is deleted
  first: its sessions ended when it closed, and reopening it would raise it over the person's.
  Spawns at the same moment share one lookup, so one window is made.
- `tree` reads one window. With several open, flowd reads each open window's tree and merges them, so
  sessions in another window are not taken for closed (a restart's reconcile, split panes, a lost
  spawn's lookup). Commands that target a session by id already work across windows.
- Not for `terminal: zmx`.

## Testing

agterm (fake agtermctl): a spawn with `window` uses the open one, or deletes a closed one and makes it
minimized, once for two spawns at once; tree reads each open window. defs: `window` parses; a non-name
is an error.
