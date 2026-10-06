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
};
```

| Field | Meaning |
|---|---|
| `name` | The namespace of its events and actions. `flow` and `signal` are reserved. |
| `events` | The event types it emits, without the prefix. They feed validation and the editor's dropdown. |
| `start(ctx)` | For sources that push: a socket, a webhook listener. May return a promise; a rejection is reported. |
| `watch(w, ctx)` | Called when someone subscribes to one of the plugin's types: an entry starts waiting on it (a **wait**), or a process has an `on:` trigger for it (a **trigger subscription**). Returns a function that stops the watch; it is called when the entry stops waiting (event arrived, timeout, goto, stop) or the trigger goes away. Throw to refuse what it cannot serve, with a message that says what to write instead. |
| `actions` | Functions called by `{do: <name>.<action>, with: {...}}` entries. Resolving marks the entry done; throwing fails it with the error as the note. |

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
| `gh.review` | PR only | Without the options below: `gh pr view <pr> --json reviews,comments`. With them: one `gh api graphql` query (PR author, decision, review requests, reviews, comments) | Without options: `reviews`, `comments` (counts). With them: `pr`, `id`, `by`, `kind` (`review`/`comment`), `state`, `decision`, `url`, `reviews`, `comments` | Without options: none; emits when a count changes. With them: `done` for an `APPROVED` review, `failed` for `CHANGES_REQUESTED`, none otherwise. |
| `gh.opened` | repo (`with.base?`, `with.label?`) | `gh pr list --state open` | as `gh.merged` in repo mode | `done`. With a label: when an open PR first shows up with it (opened with it, or labelled later). |
| `gh.ci` | repo (`with.branch` required, `with.workflow?`) | `gh run list --branch <b>` | `run` (URL), `id`, `workflow`, `conclusion`, `branch`, `sha`, `event` | Once per workflow run, when it completes: `done` on `success`, else `failed`. |

**`gh.review` from the reviewer.** Three `wait_for.with` options narrow a `gh.review` wait:

| Option | Values | Meaning |
|---|---|---|
| `from` | `requested`, a login, or logins separated by commas | Whose reviews and comments count. `requested`: every **user** ever requested as a reviewer on the PR, read from its timeline, so a reviewer who already reviewed and left the current requests still counts, and one assigned after the wait armed counts too. Teams never count as people. With `from`, bots and the PR's author never count. |
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
