# gh.review From the Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (or subagent-driven-development). Steps use `- [ ]`.

**Goal:** `gh.review` waits can be limited to the requested reviewer(s) or named logins, ignore bots and the PR author, wait for decisions only, fire at once on an existing decision, and never re-fire on the review that already woke the entry.

**Spec:** `docs/specs/2026-10-07-gh-review-from-reviewer-design.md`. Follow `CLAUDE.md`.

## Global Constraints

- Read the current code first; the snippets show the logic. Without `from`, `gh.review` keeps today's count-based behaviour and its existing tests pass unchanged.
- Tests use recorded GraphQL answers through the fake `exec`; never call the real `gh` from a test. The one manual check is a read-only GraphQL query on a public repository.
- No employer names, logins or PR numbers in code, tests or docs (the repository is public): use `alice`, `bob`, `org/frontend-team`, `ci-bot`.
- `npm test` and `npm run typecheck` green after every task; one commit per task, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The retry loop: changes requested → the agent re-arms with `flow failed` → no immediate fire; a new review → fire. (Tasks 1, 2)
2. The round-robin reviewer who already reviewed (gone from current requests) still counts. (Task 2)
3. A bot or the PR author never wakes a `from` wait; a team request never counts as a person. (Task 2)
4. `only: decisions` on a pure wait: a comment does not close it. (Task 2)
5. Existing `gh.review` waits without `from` behave exactly as before. (Task 2)

---

### Task 1: `previous` — what last woke the entry

**Files:** `src/types.ts`, `src/engine.ts`, `src/plugins.ts`, `src/daemon.ts`; tests `test/engine-runtime.test.ts`, `test/daemon.test.ts`

- [ ] `Action` `watch` gains `previous?: { type: string; data: Dict }`. In `enter()`, when the entry waits, set it from the entry's stored `event` **only if** that event's type equals the wait's `on` (the entry's `event` survives `retry`, since `enter` does not clear it; `jump` and a new iteration start from `blankEntry()`, so it is gone there — check this holds in the current code and keep it so).
- [ ] `Watch` gains `previous?: { type: string; data: Dict }`; the daemon passes it from the action; `rearm` after a restart passes the entry's stored event the same way.
- [ ] Tests first. Engine: a waiting entry woken by an event, then `retry` → the new watch action carries `previous` with that event's data; after `goto` to it → no `previous`; first arm → none. Daemon: the test plugin records `w.previous`; after a wake and a `retry` it receives it.
- [ ] Commit `feat(engine): a re-armed watch knows the event that last woke its entry`.

### Task 2: gh — `from`, `only`, `already`

**Files:** `plugins/gh.ts`, `test/gh.test.ts`

Pure parts first, over a recorded answer shaped like the spec's GraphQL query:

```ts
interface ReviewAnswer {
  author: { login: string };
  reviewDecision: string | null;
  requested: string[];                                   // users from REVIEW_REQUESTED_EVENT, teams/bots dropped
  items: { id: string; kind: "review" | "comment"; by: string; bot: boolean; state: string; at: string; url: string }[];
}

export function parseReviewAnswer(json: unknown): ReviewAnswer        // from the GraphQL response
export function countedItems(a: ReviewAnswer, o: { from: string; only?: string }): ReviewAnswer["items"]
  // from === "requested" → by ∈ a.requested; else by ∈ the comma list; never bot, never a.author.login;
  // only === "decisions" → kind review with state APPROVED | CHANGES_REQUESTED; sorted oldest first
export const reviewOutcome = (state: string) => (state === "APPROVED" ? "done" : state === "CHANGES_REQUESTED" ? "failed" : undefined);
```

The poll: `gh api graphql -f query=… -F owner=… -F name=… -F number=…` (owner/name/number parsed from the PR URL; a bare number needs `with.repo`). First poll: if `already` and the newest counted decision's `id` ≠ `previous?.data.id`, emit it; otherwise record every item id as seen. Later polls: emit the oldest unseen counted item. A wait emits once and stops. Event `data`: `pr`, `id`, `by`, `kind`, `state`, `decision`, `url`, plus `reviews`/`comments` counts; `outcome` from `reviewOutcome`. Unknown `only` throws at arm: `gh.review: only must be "decisions"`. `requested` is re-read every poll.

- [ ] Tests first (fake `exec` returning recorded answers): requested users without teams or bots; a reviewer who already reviewed and left current requests still counts (they are in the timeline); bots and the author ignored; a login list; `only: decisions`; outcome mapping; baseline then oldest unseen; `already` fires on an existing decision; `already` with `previous` equal to that review → no fire, then a newer review → fire; a reviewer added after arming counts; no `from` → today's behaviour (existing tests untouched).
- [ ] Commit `feat(gh): gh.review from the requested reviewer — from, only, already`.

### Task 3: Docs and a live read

- [ ] `docs/plugins.md` gh section: the three options, the data and outcome, `previous`, and the note that a pure `gh.review` wait should use `only: decisions`. Generic `previous` in the Watch fields table.
- [ ] `docs/processes.md`: recipe "wait for the requested reviewer" (an agent step looping with `retry`, and a pure decision wait with `on_fail: {goto: fix}`).
- [ ] `skills/flow-author/SKILL.md`: a trap line — a `gh.review` wait without `from` wakes on bots; a pure one needs `only: decisions`.
- [ ] Manual, read-only: run the poll's GraphQL query against one merged PR of a public repository (e.g. `cli/cli`) and check `parseReviewAnswer` handles it (bots typed `Bot`, teams without a login). No private repository.
- [ ] `npm test && npm run typecheck`; commit `docs: gh.review from the reviewer`.
- [ ] Report to the session that sent the plan: branch, commits, test count, deviations. Do not merge or restart flowd.
