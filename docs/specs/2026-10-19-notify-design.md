# What a run says in the conversation, and making agents answer there

## Problem

Since [2026-10-18-run-chat-design.md](2026-10-18-run-chat-design.md) flowd posts two fixed English
lines to a run's conversation — "`<run>` waits for you: …" and "`<run>` is done / was stopped" — for
every process, with no way to turn either off or word it differently, and nothing tells the person
when a single step is done. Separately, a person's message reaches the agent as
`<name> (telegram): <text>`; an agent often answers it in its terminal, which nobody reads.

## Goals

- Per entry: whether "waits for you" is posted, whether "done" is posted when the entry is done,
  and the text of each, with placeholders.
- Per process: whether the run's end is posted, and the text for done and for stopped.
- Defaults keep today's behaviour: "waits for you" on, the run's end on, an entry's done off.
- A person's message tells the agent plainly to answer with `flow say`, and flowd reminds an agent
  once when its turn ends without having answered.

## Non-goals

- Changing the default texts' language (the repo is public; texts are the person's to write).
- Notifying other people or other channels; per-person settings.
- Forcing an answer: one reminder, then it is the person's to notice.

## Decisions

### Where the settings live

- A step file's frontmatter: `notify: {waits?, waits_text?, done?, done_text?}`.
- A process entry: the same `notify:` map; it applies to any entry kind (`sh`, waits, `inner`,
  `do: type`, human steps) and its keys override the step file's, key by key.
- The process: `notify: {end?, done_text?, stopped_text?}`.
- Validation (`flow check`): unknown keys, non-boolean switches, non-string texts are errors;
  a process-level `waits` or an entry-level `end` is an error saying where it belongs.

### When

- **waits** (default `true`): as today, when the run comes to need the person — its current entry
  is a human step, an agent wait with `--human`, a bare `inner`, or the run stopped for the person.
  The entry whose settings decide is the run's current entry.
- **done** (default `false`): when an entry's status turns `done` (an agent's `flow done`, a human's,
  an `sh` exiting 0, an event closing a wait). Not for `skipped` or `failed`. Opens the conversation
  if there is none.
- **end** (default `true`): when a root run ends, only if it has a conversation (as today); the
  conversation is closed after it either way. Off: nothing is posted, the conversation still closes.
- A nested run posts into its root's conversation, with its own entries' and its own process's
  settings, except **end**: a nested run's end is not posted (its root goes on), as today.

### Texts and placeholders

Rendered with the same `{{path}}` templates as prompts, against:

| Path | Value |
|---|---|
| `run.id`, `run.process`, `run.n`, `run.iteration`, `run.date`, `run.title` | the run (`run.title` is `vars.title`, empty when unset) |
| `vars.<name>` | the run's vars |
| `step.id`, `step.summary` | the entry (summary: the step file's, empty for others) |
| `note` | waits: the wait's note, else the stop reason, else the step's summary; done: the report's note; stopped: the reason |
| `reason` | the run's reason (stopped, needs-human), empty otherwise |

A text whose placeholder cannot be rendered falls back to the default text, and flowd logs which
placeholder was missing: a typo never silences a notice. Default texts: `<run.id> waits for you: <note>`,
`<run.id>: <step.id> done[: <note>]`, `<run.id> is done`, `<run.id> was stopped[: <reason>]`.

### The person's message to the agent

Typed as:

```
<from> wrote in the run's <messenger> conversation (<run.id>):
<text>
↳ <from> reads <messenger>, not this terminal: answer with `flow say "…"`.
```

When it is typed, flowd marks the run (the one whose agent got it) `awaitingAnswer`. A `flow say` from
that run clears it. When that agent's turn ends (`completed`) with the mark still set, flowd queues one
reminder and clears the mark: `You did not answer <from>'s message in <messenger>. Answer with
\`flow say "…"\` — they do not read this terminal.` A new message sets the mark again. The mark lives
in memory (a flowd restart forgets it: at worst one reminder is missed).

## Testing

- defs: the three `notify` maps parse; wrong keys and types and misplaced keys are reported.
- daemon (fake chat): waits off on an entry posts nothing and opens nothing; a custom waits text with
  `{{note}}` and `{{vars.x}}`; an entry's done posts its text with the report's note, nothing for
  failed or skipped; end off posts nothing but still closes; custom done/stopped texts; a missing
  placeholder falls back to the default and logs it; entry `notify` overrides the step file's.
- daemon: a person's message is typed with the instruction; a turn end without `flow say` gets one
  reminder; with a `flow say` none; a second turn end no second reminder.
