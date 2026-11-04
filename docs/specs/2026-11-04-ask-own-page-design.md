# Asking on a page the agent made itself

Amends [2026-11-04-pages-adapter-design.md](2026-11-04-pages-adapter-design.md).

## Problem

A pages adapter gets the agent's fragment and has to wrap it into a page, so the shape of every question
(the buttons, what counts as a decision, who may make it) is fixed in one place. In a setup whose
document service lets an agent build a small app (a page, a store for its rows, a handler that checks
who decides), the agent can make a page that fits the question: an approve/decline on a report, a pick of
A/B/C, a form. What it cannot do is hand that page to flowd, so that flowd waits for the person, posts the
link, and types the answer into the agent.

## Decisions

- **`flow ask --link URL --note T`**: the agent made the page itself and gives its link instead of a
  file. flowd calls the active adapter's `ask` with `link` (and no `fragment`); the adapter checks it can
  read that page's answers (it is the kind of page it serves, in a place it reads) and returns the link to
  post, usually the same. The rest is `flow ask` as before: the wait, the post, the printed link, the
  answers through `ctx.answer` typed into the agent, `close` once the run moves on. Without an active
  adapter it is refused: the listener serves only the pages it makes. A FILE and `--link` together are
  refused.
- **A fragment goes to the listener when it is on**, and to the adapter only when there is no listener
  (this replaces "the adapter wins over `FLOWS_REPORTS_URL`" for fragments). So one flowd can serve
  fragment questions from its listener while its agents ask on pages of their own; an adapter that has no
  way to wrap a fragment refuses it and says what to do instead.
- What a page of one's own must be (its store, its rows, who may answer) is the adapter's to say: in its
  docs and the skills of the setup that has it. flowd's skill says only that `--link` exists.

## Testing

daemon (the fake adapter): `--link` calls `ask` with the link and no fragment, waits, posts, types the
adapter's answers; `--link` without an adapter is refused; a non-http link is refused; a fragment with
both the listener and an adapter goes to the listener; with only the adapter, to the adapter. cli:
`flow ask --link` sends it, FILE and `--link` together are refused.
