# Pages from a plugin: reports and question pages served elsewhere

Amends [2026-10-29-ask-pages-design.md](2026-10-29-ask-pages-design.md).

## Problem

Reports (`flow publish`, `flow say --file`) and question pages (`flow ask`) are served only by flowd's own
listener. Its link is the only key, and exposing it means a public name and a reverse proxy for every
flowd. A setup that already has a place for documents (a wiki, a document store with its own logins) would
rather keep the pages there: behind that place's sign-in, next to its other documents, searchable,
readable when the Mac is asleep. flowd has no way to hand pages to anything but itself.

## Goals

- A plugin can serve the pages: it takes a question and gives back its link, and later the person's
  answers. The rest of `flow ask` does not change: the agent writes the same fragment, runs the same
  command, gets the answer typed into its session in the same shape; a sleeping agent wakes as before.
- An agent that published a page somewhere itself can post its link with `flow say`.
- The built-in listener keeps working, unchanged, for a setup with no such plugin.

## Non-goals

- A plugin for any particular document service in this repository: one is written in the setup that
  uses it (`$FLOWS_HOME/plugins/`).
- flowd uploading reports through a plugin. An agent that has a document service publishes there itself
  (its tools give it the titles, the folders, the updates of one document); flowd only posts the link.
- Moving pages already published by the listener.

## Decisions

- **A pages adapter**, the third kind beside the chat adapter and the login: a plugin with
  `pages: {ask, close, check?}`. One is active, chosen as the chat adapter is: the plugin with `pages`
  whose name has a section in `plugins.yaml`; two are refused with that said. When none is active and
  `FLOWS_REPORTS_URL` is set, the built-in listener is the adapter, as now.
  ```ts
  interface PagesAdapter {
    /** the question page; `fragment` is the agent's file as written, `id` flowd's own (32 hex) */
    ask(q: { id: string; run: string; process: string; entry: string; title: string; fragment: string }, ctx): Promise<{ url: string }>;
    /** the question takes no more answers: the run left the entry that asked, or ended */
    close(id: string, ctx): Promise<unknown>;
    /** optional: refuse a link `flow say --link` would post (a page that does not exist) */
    check?(url: string, ctx): Promise<unknown>;
  }
  ```
  An adapter that cannot reach flowd (no inbound connection) polls for answers itself and hands each to
  `ctx.answer({id, answer})`; the listener calls it on a POST, as it calls `questionPost` now. Drafts are the
  adapter's business: flowd keeps none for a plugin's page.
- **`flow ask`** with a plugin adapter: flowd checks the fragment and the step as now, records the question
  under its id (no token, no copy in `reports/`), calls `ask`, then sets the wait, posts the note and the
  link, and prints the link, as now. A failing `ask` refuses the command with the adapter's error and sets
  no wait. An answer through `ctx.answer` takes the path of a POSTed one: parsed into the overlay's shape,
  dropped with a log line when the question is closed or unknown, typed into the asking role, a second one
  marked as a change. The adapter decides what counts as a second answer and sends each once.
- **Closing.** At each tick flowd closes the open questions whose run has left the entry that asked (the
  same test as `questionOpen`) by calling `close` once, and marks them closed in the store; a failing
  `close` is tried again at the next tick and shown under the plugin. The listener's own pages need no
  call: they ask flowd.
- **`flow say --link URL`** (repeatable): each link on its own line after the text. Only `http(s)` links;
  with an adapter that has `check`, a link it refuses is not sent and the command says why. `--file` stays
  for the listener and for files that are not pages (they go as attachments); with a plugin adapter and no
  listener, `--file page.html` is refused and says to publish the page and pass `--link`. `flow publish`
  stays the listener's and says the same without it.
- **Docs**: reports.md gains "Pages from a plugin" (the interface, polling, closing, the security of a page
  behind someone else's sign-in); plugins.md the adapter; cli.md `--link`; skills/flow how to post a link
  to a page the agent published; skills/flow-author nothing new.

## Testing

plugins: a plugin with `pages` is the active adapter when configured, two are refused, the listener is the
fallback. daemon (a fake adapter): `flow ask` calls `ask` with the fragment and records the question,
sets the wait with the adapter's link, posts it; a failing `ask` sets no wait; `ctx.answer` types the
answer into the role (a sleeping role wakes), a second one as a change, one for a closed or unknown
question is dropped; leaving the entry calls `close` once at the next tick, a failing one is retried.
cli: `flow say --link` appends the links, refuses a non-http one and one `check` refuses; `--file` of a
page with only a plugin adapter is refused. The listener's tests stay as they are.
