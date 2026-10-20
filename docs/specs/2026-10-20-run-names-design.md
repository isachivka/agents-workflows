# Run names a person can read

## Problem

A run is called by its id everywhere a person looks for it: a Telegram topic reads
`jira-task #6 · [FE] Undo of a mixed …` (the process name first, the work second) or just `obs-sync #12`.
Process names are short handles for the CLI (`obs-sync`, `bff-sync-kick`); the run number says nothing
about which day's sync it is. A topic is named once, when it opens: a title that comes later (the PR opened
after the first notice) never reaches it.

## Decisions

- **A process's label.** A new optional process key `label:` — a few words in the person's language
  ("Frontend errors, daily"). Without it the process name stands in. The UI shows it wherever a process is
  named for a person (the process list and page, a run's secondary line); the CLI keeps names.
- **A run's name**, computed by flowd and given to the UI (`name` in a run's summary) and the messenger:
  - with a title (`vars.title`): `<title> · <label>`;
  - without: `<label> · DD.MM HH:MM`, the time the run was created, flowd's local time (two runs a day,
    as `rr-pto`, stay apart). The run number is left out; the UI keeps the id in small print.
- **Topics follow the name.** A chat adapter gets the name at `open` (`run.name`) and an optional
  `rename(address, name)`; flowd calls it when a root run's name changes while its conversation is open
  (the title arrives or the PR is renamed). Telegram renames the topic (`editForumTopic`), cutting the title,
  not the label, to fit 128 characters.
- Unchanged: run ids, the CLI, notice texts (they are inside the topic), `{{run.*}}` placeholders.

## Testing

- defs: `label` parses; a non-string is an error.
- daemon (fake chat): open gets `<label> · DD.MM HH:MM` for a run without a title and `<title> · <label>`
  with one; setting a title on a run with an open conversation renames it once; no rename for a nested run
  or a closed conversation; an adapter without `rename` is fine.
- http: a run's summary carries `name`; the process list carries `label`.
- telegram: `rename` calls `editForumTopic`, a long title is cut and the label kept.
