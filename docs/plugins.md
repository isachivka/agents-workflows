# Writing a plugin

A plugin adds an event source (CI finished, a message arrived) or an action a process can call.
Write one instead of changing the daemon: the core knows nothing about GitHub, Slack or timers.

## The interface

A plugin is a TypeScript file whose default export is an object (`src/plugins.ts`):

```ts
export default {
  name: "gh",                                  // lowercase: ^[a-z][a-z0-9-]*$
  events: ["checks", "merged", "review"],      // emitted as gh.checks, gh.merged, gh.review
  start(ctx) {},                               // optional: once at daemon start
  watch(w, ctx) { return () => {}; },          // optional: a wait or a trigger wants one of its events
  actions: { post(args, ctx) {} },             // optional: `do: gh.post` in a process
  title({ vars, cwd }, ctx) {},                // optional: what a run is about, from its vars
  chat: { open, post, close },                 // optional: a messenger for runs' conversations
  login: { page, verify },                     // optional: a login for the UI from outside
  stop(ctx) {},                                // optional: when flowd stops
};
```

| Field | Meaning |
|---|---|
| `name` | The namespace of its events and actions. `flow` and `signal` are reserved. |
| `events` | The event types it emits, without the prefix. They feed validation and the editor's dropdown. |
| `start(ctx)` | For sources that push: a socket, a webhook listener. May return a promise; a rejection is reported. |
| `watch(w, ctx)` | Called when someone subscribes to one of the plugin's types: an entry starts waiting on it (a **wait**), or a process has an `on:` trigger for it (a **trigger subscription**). Returns a function that stops the watch; it is called when the entry stops waiting (event arrived, timeout, goto, stop) or the trigger goes away. Throw to refuse what it cannot serve, with a message that says what to write instead. |
| `actions` | Functions called by `{do: <name>.<action>, with: {...}}` entries. Resolving marks the entry done; throwing fails it with the error as the note. |
| `chat` | A messenger: see [Chat adapters](#chat-adapters). |
| `login` | A login for the UI from outside: see [Logins](#logins). |
| `stop(ctx)` | When flowd stops: end what `start` began (a long poll, a socket). May return a promise. |
| `title({vars, cwd}, ctx)` | What a run is about, in words, from its vars: `gh` returns the title of `vars.pr`. flowd asks when a run's `pr` changes and every 10 minutes for each open run with a `pr`, and stores a new answer in `vars.title`. Return `undefined` when it does not know; a throw is shown in the plugin's status and the old title stays. The first plugin with an answer wins. |

`w` (a `Watch`):

| Field | Meaning |
|---|---|
| `run`, `entry` | A wait: which entry waits; put them on the event to target it. A trigger subscription has neither. |
| `type` | The full event type wanted (`gh.checks`). |
| `with` | A wait: the entry's `wait_for.with`, templates already rendered. A trigger: the trigger's `with`, plain values. |
| `cwd` | The process's `cwd`, `~` expanded: where a repo-bound plugin should run its commands. |
| `vars` | A wait: the run's vars when the watch started. A trigger: `{}`. |
| `processes` | A trigger subscription: the processes that asked for it (it is shared by identical triggers). |
| `previous` | A wait armed again in the same iteration (after `retry`, or a `goto` back to it): `{type, data}` of the event that last woke its entry. Use it to avoid firing again on that same thing. Absent on a first arm and in a new iteration. |

**Wait or trigger.** Tell them apart by `w.run`. For a wait, emit with `run` and `entry`, once, and
stop. For a trigger subscription, emit without `run` and keep emitting for as long as the
subscription lives. The `ctx` a subscription gets marks what it emits as coming from that
subscription, so the event starts only the processes that asked for it (each through its
trigger's `where`) and wakes no waiting entry.

`ctx` (a `PluginCtx`):

| Field | Meaning |
|---|---|
| `emit({type, data?, outcome?, run?, entry?})` | Sends an event. The plugin name is prefixed if missing (`checks` → `gh.checks`); `source` is set to the plugin name. With `run` and `entry` it goes to that entry only. Without them, from a trigger subscription's `ctx` it starts only that subscription's processes; from `start` it is a broadcast that wakes every matching wait and trigger. `outcome: "failed"` fails a pure wait or a human step; an agent step sees it as `{{event.outcome}}`. |
| `message({address, text, from})` | A chat adapter: the person wrote `text` in the conversation at `address`; `from` is their display name. The adapter decides who may write; flowd trusts what it is given. |
| `log(msg)` | A line in flowd's log, prefixed with the plugin name. |
| `error(err, w?)` | Reports a problem: shown in Settings → Plugins (and on the watch, with `w`). The waiting entry is not failed. `error(null, w)` clears the watch's error once it works again. |
| `config` | This plugin's section of `$FLOWS_HOME/plugins.yaml`, or `{}`. |

## Lifecycle

- **Loading.** At start flowd loads every `*.ts` file of the repo's `plugins/`, then of
  `$FLOWS_HOME/plugins/`, in name order. A later plugin with the same name replaces the earlier
  one, so yours wins over a built-in. A file that fails to load is listed in Settings → Plugins
  and by `flow check` as `plugin <file>: <error>`.
- **No hot reload.** Restart flowd after changing a plugin: Settings → Restart flows does it, or
  `launchctl kickstart -k gui/$UID/local.flows`.
- **`start`** runs once, after the definitions are loaded.
- **`watch`** runs only while an entry waits or a trigger asks for the type, so a polling plugin
  polls only what someone wants. After a restart every waiting entry's watch and every trigger
  subscription is started again. A definition reload re-arms only an entry whose `wait_for`
  changed, and starts or stops only trigger subscriptions that appeared or went away; the others
  keep running, so a plugin that compares against what it saw at start (like `gh.review`, or gh's
  repo mode) does not miss or repeat an event.
- **Failures.** A throw from `start` or an action is caught and reported. An action still running
  when flowd stops is not resumed: at the next start its entry fails with
  `flowd restarted while the action ran`, and `on_fail` decides. A `watch` that throws is
  retried after 5 s, doubling each time, up to 5 minutes. A problem inside a running watch (a
  failed poll) should go to `ctx.error(e, w)`; keep polling.

## Configuration

`$FLOWS_HOME/plugins.yaml` holds one mapping per plugin name:

```yaml
gh:
  interval_ms: 30000
```

`ctx.config` of the `gh` plugin is then `{interval_ms: 30000}`. The file is read at start.

## Worked example: gh

`plugins/gh.ts`, built in. It works in two modes. Each watch polls at once and then every
`interval_ms` (default 60 000), running `gh` in the process's `cwd`.

**PR mode** watches one pull request: `with.pr`, or for a wait the run's `vars.pr` (set with
`flow set pr=<url>`, or filled in by a trigger). It emits once.

**Repo mode** watches a repository: `with.repo` (`owner/name`), or when absent the repo of the
process's `cwd`. Its first poll is a baseline; after that it emits each new item, oldest first:
for `gh.merged` a PR merged after the newest merge seen (merged PRs are listed most recently
updated first, so a long-lived PR merged now is found), for `gh.opened` a PR created after the
newest one seen, or with a label a PR that first shows up with it, for `gh.ci` a run not seen
before. A wait in repo mode emits once to its entry and stops; a trigger subscription keeps
emitting. A trigger always watches a repo: `with.pr` on a trigger is refused. A `gh.merged` wait
without a PR needs `with.repo`, `with.base` or `with.label` to mean "any merge"; otherwise it
asks for a PR.

| Event | Mode | Polls | Emits (`data`) | Outcome |
|---|---|---|---|---|
| `gh.checks` | PR only | `gh pr checks <pr> --required --json name,bucket,link` | `pr`, `failed` (names), `links` | When no required check is pending: `done` if none failed or was cancelled, else `failed`. A PR with no checks counts as pending until 5 polls in a row find none, then `done`: right after a PR opens, CI has not registered its checks yet. |
| `gh.merged` | PR, or repo (`with.base?`, `with.label?`) | PR: `gh pr view <pr> --json state`; repo: `gh pr list --state merged --search sort:updated-desc` | PR: `pr`, `state`; repo: `pr` (URL), `number`, `title`, `branch`, `base`, `author` | `done` when merged; in PR mode `failed` when closed unmerged |
| `gh.review` | PR only | Without the options below: `gh pr view <pr> --json state,reviews,comments`. With them: one `gh api graphql` query (PR author, decision, review requests, reviews, comments) | Without options: `reviews`, `comments` (counts). With them: `pr`, `id`, `by`, `kind` (`review`/`comment`), `state`, `decision`, `url`, `reviews`, `comments` | Without options: none; emits when a count changes. With them: `done` for an `APPROVED` review, `failed` for `CHANGES_REQUESTED`, none otherwise. Either way a merged PR ends the wait as `done` and a closed one as `failed`, at once, with `state` and `merged` in the data (and, with the options, the same keys as a review: `kind` is `merged`/`closed`, `by` and `id` empty, `url` the PR). |
| `gh.opened` | repo (`with.base?`, `with.label?`) | `gh pr list --state open` | as `gh.merged` in repo mode | `done`. With a label: when an open PR first shows up with it (opened with it, or labelled later). |
| `gh.ci` | repo (`with.branch` required, `with.workflow?`) | `gh run list --branch <b>` | `run` (URL), `id`, `workflow`, `conclusion`, `branch`, `sha`, `event` | Once per workflow run, when it completes: `done` on `success`, else `failed`. |

**`gh.review` from the reviewer.** Three `wait_for.with` options narrow a `gh.review` wait:

| Option | Values | Meaning |
|---|---|---|
| `from` | `requested`, a login, or logins separated by commas | Whose reviews and comments count. `requested`: every **user** ever requested as a reviewer on the PR, read from its timeline, so a reviewer who already reviewed and left the current requests still counts, and one assigned after the wait armed counts too. A team is not a person, but whoever reviews on its behalf (a code-owner team is often the only request, and GitHub drops it once a member reviews) counts as requested from that review on. With `from`, bots and the PR's author never count. |
| `only` | `decisions` | Only `APPROVED` and `CHANGES_REQUESTED` reviews count; comments and `COMMENTED` reviews do not. |
| `already` | `true` | On the first poll, a decision that is already there fires at once, unless it is the one that last woke this entry (`previous`), or older than it. A `goto` back to the wait in the same iteration therefore needs a new decision: the one that already woke it does not count again. |

```yaml
- {step: address-review, role: dev, wait_for: {on: gh.review, with: {from: requested}}, on_fail: retry}
- {id: approval, wait_for: {on: gh.review, with: {from: requested, only: decisions, already: true}}, on_fail: {goto: fix-review}}
```

Logins are compared without case. The event's `reviews` and `comments` are the PR's totals; `at`
is when the review was submitted or the comment written. Without these options `gh.review`
counts everyone, bots included, as before. An event without an
outcome closes a pure wait as `done`, so a pure `gh.review` wait should use `only: decisions`.
The PR is a URL (`vars.pr` or `with.pr`); a bare PR number needs `with.repo` (`owner/name`). An
unknown `only` refuses the wait: `gh.review: only must be "decisions"`.

Repo-mode lists ask for the latest 30 items. `gh.checks` and `gh.review` refuse to work without a
PR; as a trigger, `gh.checks` says `to start on CI results use gh.ci`. Nothing that happened
before the baseline (or while flowd was down) fires.

`gh` must be installed and logged in for the user flowd runs as.

## Chat adapters

A run talks with the person in its own conversation in a messenger: a topic in a Telegram group,
a channel in Mattermost, a thread in Slack. The core knows only "the run's conversation"; a
plugin with a `chat` field speaks the messenger. See [concepts](concepts.md#a-runs-conversation)
for what goes through it.

```ts
chat: {
  open(run: { id, process, title? }, ctx): Promise<string>,              // → the conversation's address
  post(address, msg: { text: string; file?: string }, ctx): Promise<void>, // file: a local path
  close(address, end: { outcome: "done" | "stopped" }, ctx): Promise<void>,
}
```

- **Which one.** The adapter is active when `plugins.yaml` has a section with its name. Two
  active is an error, shown in Settings → Plugins and by `flow check`; no conversation works
  until one section is removed. Switching messengers is moving the section; a run's address is
  stored with the adapter's name, so after a switch a run opens a new conversation.
- **Addresses.** `open` returns a string the adapter can post to later and recognise in incoming
  messages; flowd stores it per root run (a nested run uses its root's) and never parses it.
- **Incoming.** The adapter calls `ctx.message({address, text, from})` for each message it accepts;
  it filters who may write (its config) and what (text only, say).
- **Failures.** A throw from `open` or `post` fails the `flow say` that caused it, with the error;
  for flowd's own messages it is logged and shown as the plugin's last error, never failing a run.
- Only conversations flowd opened are routed; a message anywhere else is logged and dropped.

### Telegram

`plugins/telegram.ts`, built in, on [grammY](https://grammy.dev). Each run gets a topic in one
group; the bot long-polls, so flowd needs no inbound port.

Setup:

1. Make a bot with [@BotFather](https://t.me/BotFather) for this flowd alone: Telegram lets one
   process poll a bot (a second flowd with the same token gets `409 Conflict`).
2. Make a group, turn on **Topics** in its settings, add the bot and make it an admin with
   **Manage topics**. As an admin it sees every message; privacy mode can stay on.
3. Write anything in the group, then read the group's id and yours from
   `https://api.telegram.org/bot<token>/getUpdates` (`message.chat.id`, `message.from.id`).
4. `$FLOWS_HOME/plugins.yaml`:
   ```yaml
   telegram:
     token: "123456:ABC…"
     chat: -1001234567890   # the group
     users: [111111111]     # who may write to agents
   ```
5. Restart flowd.

| | |
|---|---|
| `open` | `createForumTopic`, named `<process> #<n> · <title>` (cut to 128 characters). Address `<chat>/<topic id>`. |
| `post` | `sendMessage` into the topic as plain text (no Markdown parsing to fail), cut into messages of 4096 characters at a line break. With a file: `sendDocument`, the text as its caption when it fits in 1024 characters, else a message first. |
| `close` | `closeForumTopic`. |
| incoming | A message in the group, in a topic, from a user in `users`: its `text` or `caption`. A message from anyone else is logged and ignored. Messages sent while flowd was down arrive at its next start (Telegram keeps them for a day). |

Without a `token` the plugin does nothing. Errors name the fix: not an admin with "Manage topics",
`chat not found` (the id, or the bot is not in the group), Topics turned off.

## Logins

Through `FLOWD_PUBLIC_URL` (the UI served from outside by a reverse proxy), and for every request
from `FLOWD_PUBLIC_FROM` (the proxy's address, when it rewrites `Host`), flowd asks for a login;
local and LAN requests never do. A plugin with a `login` field provides it:

```ts
login: {
  page({ callback }, ctx): string,                       // the login page's body: the provider's button
  verify(query: Record<string, string>, ctx): { user, name } | { error },   // the callback's check
}
```

- Active like a chat adapter: its section is in `plugins.yaml`; two active is an error.
- `GET /login` shows the page; the provider sends the person back to `callback`,
  `<FLOWD_PUBLIC_URL>/auth/<plugin name>`, whose query `verify` checks. A pass starts a 30-day
  session (cookie `flows_session`, only its SHA-256 is stored); `POST /logout` ends it.
- Without a session, pages redirect to `/login` and `/api/*` answer 401. With no login plugin, the
  public name serves only a page saying so.
- Who may log in is the plugin's call (its config).

### Telegram login

The Telegram plugin is also a login, with the same `token` and `users`: Telegram's
[OpenID Connect](https://core.telegram.org/bots/telegram-login), code flow with PKCE. The login page
links to `oauth.telegram.org/auth`; the person confirms in Telegram and comes back to
`/auth/telegram` with a code, which flowd trades for an ID token (client id and secret, Basic auth).
flowd checks the token's RS256 signature against Telegram's published keys, its issuer, audience
(the bot) and expiry, and that the user's `id` is in `users`. Each login page's state is good for
10 minutes and once; a flowd restart forgets it (log in again).

Setup, in [@BotFather](https://t.me/BotFather) → the bot → **Login Widget**:

1. **Add a Redirect URI**: `<FLOWD_PUBLIC_URL>/auth/telegram`, exactly.
2. Keep the signing algorithm at RS256.
3. Copy the **Client Secret** into the plugin's section: `client_secret: "…"`. The Client ID is the
   bot's id, the token's first part, so it needs no setting.

(The older login widget, `/setdomain` and a hash signed with the bot token, is legacy; its phone
confirmation does not always arrive.)

## A minimal plugin

A wait that ends after a number of seconds. Save it as `$FLOWS_HOME/plugins/timer.ts`:

```ts
// $FLOWS_HOME/plugins/timer.ts: a wait that ends after `with.seconds`.
export default {
  name: "timer",
  events: ["elapsed"],                       // emitted as timer.elapsed
  watch(w, ctx) {
    const seconds = Number(w.with.seconds ?? 60);
    const t = setTimeout(() => {
      ctx.emit({ type: "elapsed", run: w.run, entry: w.entry, outcome: "done", data: { seconds } });
    }, seconds * 1000);
    return () => clearTimeout(t);            // called when the entry stops waiting
  },
};
```

and use it:

```yaml
steps:
  - {id: cool-down, wait_for: {on: timer.elapsed, with: {seconds: 300}}}
```

Run `flow check`, then restart flowd so it loads the plugin.

## Testing a plugin

Inject the I/O. `plugins/gh.ts` exports `makeGhPlugin(exec, intervalMs)` and `pollOnce(kind, pr,
exec, baseline)`, so `test/gh.test.ts` drives it with a fake `gh` and a fake `ctx` that records
`emit` and `error`. Run the tests with `npm test`.

## Sketch: Slack

Not shipped. The shape a Slack plugin would take, with no change to the core:

- `start(ctx)` holds a Socket Mode connection and emits broadcasts `slack.dm` and `slack.mention`
  with the channel, user and text in `data`. A process triggers on them
  (`triggers: [{on: slack.mention, where: {channel: C123}}]`) or waits for them.
- `actions.post(args)` replies in a thread: `{do: slack.post, with: {channel: "…", thread: "{{vars.thread}}", text: "…"}}`.
  `with` is rendered from the run and its vars, not from an event, so an earlier step stores the
  thread with `flow set thread=…`.
