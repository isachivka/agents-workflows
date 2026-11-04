# Reports and question pages

flowd can serve agents' pages under unguessable links, on a listener of their own that is meant to be
reached from outside (a phone, through a reverse proxy). Two kinds of page go there:

- **reports**, read-only: `flow publish FILE`, or `flow say --file page.html`, which posts the link;
- **question pages**, which the person answers: `flow ask FILE --note "…"`. Their answer comes back to
  the agent that asked.

Both are part of flowd (`src/reports.ts`, `src/ask.ts`); nothing else has to be installed. A setup that
already keeps documents somewhere else, behind that place's sign-in, can serve the question pages there
instead and have its agents publish their reports there themselves: see [Pages from a plugin](#pages-from-a-plugin).

## Turning it on

The listener starts when flowd has `FLOWS_REPORTS_URL` in its environment (for the launchd agent: the
plist's `EnvironmentVariables`, then restart flowd):

| Variable | Default | What |
|---|---|---|
| `FLOWS_REPORTS_URL` | (off) | the public base links start with, e.g. `https://reports.example.net` |
| `FLOWS_REPORTS_PORT` | `7430` | the listener's port |
| `FLOWS_REPORTS_HOST` | `0.0.0.0` | the address it binds |

Point a reverse proxy at `http://<this machine>:7430` under that public name. Give the reports a name of
their own, never the UI's: a page's JavaScript runs on the reports origin, where nothing of flowd is.
flowd's log names the listener at start. Copies live in the state directory's `reports/` and are deleted
after 30 days.

## Reports

`flow publish FILE` copies a self-contained file (HTML, PDF, an image, up to 20 MB) under
`<FLOWS_REPORTS_URL>/r/<32 hex>/<name>` and prints the link. Each call is a new copy and a new link. The
link is the only key: it goes where the person reads (`flow say` posts it), not into public places. See
[`flow publish`](cli.md#flow-publish).

## Question pages

For a choice the person makes away from the Mac: tick the topics to write up, pick an option, add a comment.

1. The agent writes an HTML **fragment** (no `<html>`, `<head>` or `<body>`): any content, with named
   inputs. `choice` is the main answer: radios for one, checkboxes for several. A `<textarea name="note">`
   is added for a comment when the fragment has none. Inline `<style>` and `<script>` are fine.
   ```html
   <h2>Which topics to write up?</h2>
   <label><input type="checkbox" name="choice" value="cache"> The new cache</label>
   <label><input type="checkbox" name="choice" value="cli"> The CLI rewrite</label>
   ```
2. `flow ask q.html --note "Which topics to write up?"` from the agent's session. flowd wraps the fragment
   into a page (a form, a Send button, the saved state), publishes it, posts the note and the link in the
   run's conversation, puts the step into `flow wait --human` with the link in its note (shown in the UI
   too), and prints the link. The agent ends its turn.
3. The person opens the link, ticks, writes, presses Send. Ticks are saved as a draft while they go, so
   a page closed before Send comes back as it was left, on any device; the agent hears nothing of drafts.
4. The answer is typed into the agent that asked, as JSON in the shape the agterm question overlay
   returns, so one fragment works in both:
   ```
   ▶ flow: the person answered your question (<link>):
   {"choice":["cache"],"note":"only this one, today"}
   ```
   `choice` is always a list; any other name is a string, or a list for checkboxes and repeated names.
   A sleeping agent (`hibernate`) wakes into its conversation with it.
5. The person may change the answer and send again while the run stands on the entry that asked: the
   agent gets `the person changed their answer to …`. Once the run has moved on or ended, the page says
   the question is closed and takes nothing more.

`flow ask` is refused without the listener (ask in the agterm overlay instead), for a whole page instead
of a fragment, and outside an agent's current step. Without a messenger, or in a `notify: false` process,
the link is not posted (the command says so on stderr) but is printed and shown in the run's waiting note.

## Security

- The listener answers only `GET`/`HEAD /r/<token>/<name>` for a published file, and, for a question
  page's token only, `GET /r/<token>/answer` (the saved state) and `POST /r/<token>/answer|draft` with an
  `application/json` body of at most 64 KB. Everything else is 404. Paths are matched by pattern, never
  joined from raw input; it sends no CORS headers.
- A page is protected only by its link, for reading and for answering. The headers keep the link from
  spreading (`referrer-policy: no-referrer`, `x-robots-tag: noindex`); the Telegram adapter sends no link
  previews.
- An answer is data typed into the agent's terminal, the same as a message from the person in the
  messenger: whoever has the link can tell that agent something. Do not put question links where others
  read.

## Pages from a plugin

A plugin with a `pages` field takes the question pages over from the listener: its section in
`plugins.yaml` makes it the active adapter (two are refused), and it wins over `FLOWS_REPORTS_URL`.
flowd then serves no question page and keeps no copy; the listener, if it is still on, serves only
`flow publish` and `flow say --file`.

```ts
pages: {
  ask(q: { id, run, process, entry, title, fragment }, ctx): Promise<{ url }>, // the page; its link
  close(id, ctx): Promise<void>,                                               // no more answers
  check?(url, ctx): Promise<void>,                                             // optional: throw to refuse a link
}
```

- **`flow ask`** checks the fragment and the step as always, then calls `ask` with the fragment as the
  agent wrote it, the note as `title` and an `id` of flowd's own (32 hex). The adapter makes the page
  (the wrapping, the Send button and the drafts are its own) and returns its `http(s)` link; flowd sets
  the wait, posts the note and the link, and prints it. A throw refuses the command with
  `<plugin>: <error>`, and no wait is set.
- **Answers.** The adapter calls `ctx.answer({id, answer})` once per answer it receives, `answer` in the
  page's JSON (`choice`, a `note`, other names). flowd takes it as it takes one sent to the listener:
  typed into the agent that asked, a sleeping one woken, a second one marked as a change. An answer for an
  id it did not give this adapter, one that is not an answer, or one after the question closed is dropped
  with a line in the log. An adapter that cannot be reached from outside polls its store for them: poll
  only while it has a question open.
- **Closing.** Once the run has left the entry that asked, or ended, the next tick (every 5 s) calls
  `close` for that question, once. The page should then say the question is closed and take nothing
  more. A throw is shown under the plugin and tried again at the next tick.
- **Links.** An agent that published a report in that place itself posts it with `flow say "…" --link URL`.
  With `check`, flowd asks the adapter first and does not send a link it refuses. With an adapter and no
  listener, `flow say --file page.html` is refused and says to publish the page and pass its link.
- **Security** is the adapter's: behind a sign-in, an answer comes from someone that place let open the
  page, rather than from whoever has a link. It is still typed into the agent's terminal as the person's
  word, so the page should open only to the people who may tell that agent what to do.
