# Turning a process's messenger notices off

Amends [2026-10-19-notify-design.md](2026-10-19-notify-design.md).

## Problem

A factory process (a reel topic into N briefs, one run per reel) has dozens of small runs. Each opens a
topic in the messenger for "waits for you" and "is done", and the group floods. Turning them off took
`notify: {waits: false}` on every entry plus `notify: {end: false}` on the process.

## Decision

`notify: false` on a process: flowd posts none of its own notices (waits, done, end) for that
process's runs, so it opens no conversation for them. A nested run follows its own process's setting.
An agent's `flow say` still posts (a prompt asked for it); a conversation it opened still closes at the
run's end. `notify: false` on a step or an entry is an error (those take a mapping).

## Testing

defs: `notify: false` on a process parses to off, on a step is refused. daemon-chat: a run of such a
process posts nothing and opens nothing through waits, done and end; `flow say` still opens and posts,
and the conversation closes at the end.
