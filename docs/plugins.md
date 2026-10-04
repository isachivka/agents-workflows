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
  watch(w, ctx) { return () => {}; },          // optional: while an entry waits on one of its events
  actions: { post(args, ctx) {} },             // optional: `do: gh.post` in a process
};
```

| Field | Meaning |
|---|---|
| `name` | The namespace of its events and actions. `flow` and `signal` are reserved. |
| `events` | The event types it emits, without the prefix. They feed validation and the editor's dropdown. |
| `start(ctx)` | For sources that push: a socket, a webhook listener. May return a promise; a rejection is reported. |
| `watch(w, ctx)` | Called when an entry starts waiting on one of the plugin's types. Returns a function that stops the watch; it is called when the entry stops waiting (event arrived, timeout, goto, stop). |
| `actions` | Functions called by `{do: <name>.<action>, with: {...}}` entries. Resolving marks the entry done; throwing fails it with the error as the note. |

`w` (a `Watch`):

| Field | Meaning |
|---|---|
| `run`, `entry` | Which entry waits. Put them on the event to target it. |
| `type` | The full event type waited for (`gh.checks`). |
| `with` | The entry's `wait_for.with`, templates already rendered. |
| `vars` | The run's vars when the watch started. |

`ctx` (a `PluginCtx`):

| Field | Meaning |
|---|---|
| `emit({type, data?, outcome?, run?, entry?})` | Sends an event. The plugin name is prefixed if missing (`checks` → `gh.checks`); `source` is set to the plugin name. With `run` and `entry` it goes to that entry only; without, it is a broadcast that wakes every matching wait and trigger. `outcome: "failed"` fails a pure wait or a human step; an agent step sees it as `{{event.outcome}}`. |
| `log(msg)` | A line in flowd's log, prefixed with the plugin name. |
| `error(err, w?)` | Reports a problem: shown on the Plugins page (and on the watch, with `w`). The waiting entry is not failed. |
| `config` | This plugin's section of `$FLOWS_HOME/plugins.yaml`, or `{}`. |

## Lifecycle

- **Loading.** At start flowd loads every `*.ts` file of the repo's `plugins/`, then of
  `$FLOWS_HOME/plugins/`, in name order. A later plugin with the same name replaces the earlier
  one, so yours wins over a built-in. A file that fails to load is listed on the Plugins page
  and by `flow check` as `plugin <file>: <error>`.
- **No hot reload.** Restart flowd after changing a plugin: the Plugins page has a button, or
  `launchctl kickstart -k gui/$UID/local.flows`.
- **`start`** runs once, after the definitions are loaded.
- **`watch`** runs only while an entry waits, so a polling plugin polls only what someone waits
  for. After a restart, or a definition reload, every waiting entry's watch is started again from
  the current definition.
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

`plugins/gh.ts`, built in. The PR is `wait_for.with.pr` or, failing that, `vars.pr`; set it with
`flow set pr=<url>` before the wait. Each watch polls at once and then every `interval_ms`
(default 60 000), and emits at most once.

| Event | Polls | Outcome |
|---|---|---|
| `gh.checks` | `gh pr checks <pr> --required --json name,bucket,link` | When no required check is pending: `done` if none failed or was cancelled, else `failed` with `data.failed` (names) and `data.links`. A PR with no checks counts as pending until 5 polls in a row find none: right after a PR opens, CI has not registered its checks yet. |
| `gh.merged` | `gh pr view <pr> --json state` | `done` when `MERGED`, `failed` when `CLOSED`. |
| `gh.review` | `gh pr view <pr> --json reviews,comments` | No outcome. Emits when the review or comment count changes after the watch started. |

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
