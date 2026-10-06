# `gh.review` that waits for the reviewer, not for any comment

Status: proposed 2026-10-07 (a request from a live process). Awaiting the user's approval.

## Problem

`gh.review` (`plugins/gh.ts`) polls `gh pr view <pr> --json reviews,comments` and emits whenever
either count changes, whoever wrote it. A step that waits for the human review therefore wakes on
every bot comment (code-quality reports, image-size reports, an automated review's results) and on
the CI bots' comments after the agent's own push. A process that loops on it
(`{step: feedback, wait_for: gh.review, on_fail: retry}`) pays an agent turn and a retry for each.

Two more gaps:
- **The expected reviewer.** Teams (CODEOWNERS) are requested and the platform adds one person;
  once that person reviews they drop out of the PR's current review requests, so "who we are
  waiting for" cannot be read from the current requests alone.
- **A review that came before the wait.** If the reviewer approved while the run was still on an
  earlier step, the wait arms after the approval and never fires.

## Goals

1. A `gh.review` wait can be limited to the people it is about: the PR's requested reviewers, or
   named logins. Bots and the PR's author never wake it.
2. It can ignore comments and wait for a decision (approve / request changes) only.
3. It can fire at once when such a decision already exists.
4. The event says who did what, and its outcome lets a pure wait or a human step close on approval
   with no agent turn.

Without the new options `gh.review` behaves as today.

## Design

```yaml
- {step: feedback, role: dev, wait_for: {on: gh.review, with: {from: requested}}, on_fail: retry}
- {wait_for: {on: gh.review, with: {from: requested, only: decisions, already: true}}, on_fail: {goto: fix}}
- {step: feedback, role: dev, wait_for: {on: gh.review, with: {from: "{{vars.reviewer}}"}}}
```

### Options (`wait_for.with`, PR mode only)

| Key | Values | Meaning |
|---|---|---|
| `from` | `requested`, a login, or several logins separated by commas | Whose activity counts. `requested`: every **user** ever requested as a reviewer on the PR (from its timeline, so it includes people who already reviewed), teams excluded. Absent: anyone (today). |
| `only` | `decisions` | Count reviews with state `APPROVED` or `CHANGES_REQUESTED`; ignore `COMMENTED` reviews and conversation comments. Absent: reviews of any state and comments count. |
| `already` | `true` | On the first poll, if the latest review of a counted person is a decision, emit it at once instead of taking it as the baseline. |

Always, when `from` is set: authors of type `Bot` and the PR's author are ignored. (Without `from`
nothing is filtered, as today.) A trigger subscription cannot use `gh.review`: it needs a PR, as
before.

### What is polled

With `from` set, one GraphQL call per poll (`gh api graphql`), owner/repo/number parsed from the PR
URL (or `with.repo` + number for a bare number):
- `author { login }`, `reviewDecision`;
- `timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT])` → `requestedReviewer` of type `User`;
- `reviews(last: 50)` → `id`, `author { __typename login }`, `state`, `submittedAt`;
- `comments(last: 50)` → `id`, `author { __typename login }`, `createdAt`.

Inline review comments and thread replies arrive as reviews (usually `COMMENTED`), conversation
comments as comments. The first poll records every id it sees as the baseline (unless `already`
fires); later polls emit the oldest unseen counted item. A wait emits once and stops, as today.
`requested` is re-read on every poll, so a reviewer the platform assigns after the wait armed
counts too.

### The event

`data`: `pr`, `by` (login), `kind` (`review` or `comment`), `state` (review state, empty for a
comment), `decision` (the PR's `reviewDecision` at that poll), `url` (the review's or comment's
URL), plus today's `reviews` and `comments` counts.
`outcome`: `done` for `APPROVED`, `failed` for `CHANGES_REQUESTED`, none otherwise. A pure wait
or a human step therefore closes on approval and takes `on_fail` on requested changes; an agent
step reads `{{event.data.by}}`, `{{event.data.state}}`, `{{event.data.url}}`.

Note for pure waits: an event without an outcome closes a pure wait as `done`, so a pure wait on
`gh.review` should use `only: decisions`. `flow check` cannot know plugin options; the docs and
the `flow-author` skill say so.

### Errors

`from` with an unparsable PR reference, or GraphQL errors, surface like every gh poll error (the
waiting entry and the Plugins page show it; polling goes on). An unknown `only` value throws when
the watch arms: `gh.review: only must be "decisions"`.

## Testing

Pure functions over recorded GraphQL answers (`test/gh.test.ts`, fake exec): requested users from
the timeline without teams or bots; bots and the PR author ignored; `only: decisions` skips
`COMMENTED` and comments; outcome mapping; baseline then the oldest unseen counted item;
`already` fires on an existing decision and only then; a login list; a reviewer assigned after
arming counts; no `from` keeps today's count-based behaviour and its tests unchanged. Docs:
`plugins.md` gh section (options, data, outcome, the pure-wait note), `processes.md` recipe
"wait for the requested reviewer", `flow-author` skill trap. Manual: one read-only GraphQL call
against a public repository's merged PR to confirm the field shapes (no writes, no private repo).
