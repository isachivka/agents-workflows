# Slack: agents as colleagues in a channel

**Status: draft, not approved.** Open questions are at the end.

## Problem

Steering an agent today means its terminal; approving a human step means the flows UI. People who
work in Slack, a team included, should be able to watch an agent's work, answer it and approve its
steps where they already talk, and processes should be able to start from, and report to, a
channel.

`docs/plugins.md` sketches a Slack plugin "with no change to the core". Research (Socket Mode
without `@slack/bolt`, and the Slack adapter of the MIT-licensed Archon project) shows that is not
enough: a plugin can only emit events. It cannot type to an agent, close a human step, retry a run
or find a run by its thread. This spec adds those to the plugin interface, then builds the Slack
plugin on them.

## Goals

- A Slack bot, over Socket Mode (no public URL), that only **operators** (a list of Slack user ids)
  can talk to.
- An agent posts as the bot: `flow slack post "<markdown>"`. A run's first post starts its thread.
- An operator's reply in a run's thread reaches the run: it wakes a step waiting on `slack.reply`,
  or else is typed to the agent as a turn.
- Human steps and stopped runs show up in the thread with buttons; operators press them.
- A process may start on a mention in a channel (`slack.mention`).
- The same "say to the agent" works from the UI, for anyone without a terminal at hand.

## Non-goals (their own specs)

- Logins and an admin UI (operators and channels are configured in `plugins.yaml` for now).
- A guard model that screens operator messages.
- Jira; running on Linux; DMs; slash commands; a status message edited in place per run.

## Part 1: what plugins can do (core)

**`ctx.runs()`** returns the open runs as the UI sees them (`RunSummary`: id, process, iteration,
status, vars, roles, current entry, its kind and status, what it waits on). Read-only.

**`ctx.submit(event)`** submits a core event on behalf of the plugin, `source: "plugin:<name>"`.
Allowed types: `run.say`, `entry.report` (as `by: "human"`), `entry.retry`, `run.set`. Anything
else is refused. A plugin is trusted code the user installed; the allowlist only keeps it to what
a person can do from the UI.

**`observe(event, ctx)`**, an optional plugin export, is called after each `flow.*` event is
committed. The core adds two events so a plugin can follow a run without polling:

- `flow.step.human` `{run, entry, iteration, summary, waitsFor?}`: a human step became current.
- `flow.step.closed` `{run, entry, iteration, outcome, by, note}`: an entry finished, however it
  was closed (UI, CLI, Slack, an event).

`flow.run.needs-human`, `flow.run.done` and `flow.iteration.done` exist already.

**Plugin actions called by an agent.** `flow act <plugin>.<action> [key=value …] [--text -]` posts
to `POST /api/act {action, with, session}`. flowd finds the run by the session (as for `flow done`)
and calls the action with `with` and the run (`RunSummary`); the action's return value goes back as
JSON. `flow slack post "<text>"` is `flow act slack.post --text "<text>"`. Actions used by `do:`
entries keep working as today.

**`run.say`** `{run, text, from, role?}` becomes engine input `say`: one delivery, through the
normal outbox (never over the user's typing, never mid-turn), to `role` if given, else the current
step's agent, else the first role of the run with a session; none → refused. The line is

```
✉ <from> (a person, not a flow step): <text>
```

with a leading `▶` stripped from the text, so a message cannot pose as a flows instruction. The
`flow` skill says what to do with such a line: treat it as the person talking, answer where it came
from (`flow slack post` for Slack), keep the step's state as the step says.

**UI.** The run page gets a "Message the agent" box (`from: "the user, from the flows UI"`).

## Part 2: the Slack plugin (`plugins/slack.ts`)

**Configuration.**

```yaml
# $FLOWS_HOME/plugins.yaml
slack:
  channels: {obs: C0123ABCD}     # names processes use → channel ids
  operators: [U01ABC, U02DEF]    # who the bot listens to
```

Tokens never go in YAML: `FLOWS_SLACK_BOT_TOKEN` (`xoxb-`) and `FLOWS_SLACK_APP_TOKEN` (`xapp-`) in
flowd's environment (the launchd plist or systemd unit). An empty or invalid operator list means
**nobody**: the plugin refuses to start and says so in Settings → Plugins. Ids must match
`^[UW][A-Z0-9]+$`.

A process names its channel: `slack: {channel: obs}` (a new process key; `flow check` refuses an
unknown name).

**The run's thread** is `vars.slack_bot_thread`, a permalink. It is not `vars.slack_thread`, which
already means "the team's thread about this work" and which the bot must not write into uninvited.
The UI's Slack button links `slack_thread`, else `slack_bot_thread`.

**Posting** (`slack.post`, `{text}`, from an agent's session):
- Empty text is refused. Text is Markdown; a post goes out as `markdown_text` (12 000 characters).
- Longer text is split: on blank lines, then lines, then hard; never inside a code fence (the fence
  is closed and reopened). The first part goes where the post is addressed, the rest as replies in
  the thread, one at a time, honouring `Retry-After`.
- Addressed to the run's thread; without one, to the process's channel, and that message becomes
  the thread (posts of one run are serialised, so two first posts cannot make two threads).
- It returns `{ts, permalink}`; errors return Slack's error and a hint (`not_in_channel`: invite
  the bot).

**Listening** (Socket Mode, Node's built-in `WebSocket`; no new dependency):
- Connect: `apps.connections.open` → a single-use URL → wait for `hello` (log `num_connections`:
  more than one means another consumer is taking a share of the events).
- Ack every envelope at once (`{envelope_id}`), then work. Dedupe on `event_id` and on
  `channel:ts` (a mention arrives as `app_mention` and as `message`).
- `disconnect` `warning`/`refresh_requested`: open the new socket, then close the old one.
  `link_disabled` and auth errors: report, retry slowly. A socket with no server ping for 30 s
  (seen through `node:diagnostics_channel` `undici:websocket:ping`) is dead: reconnect, backoff
  1 s → 5 min with jitter.
- Messages: skip the bot's own and other bots'; accept plain messages, `thread_broadcast` and
  `file_share` (text only); edits and deletes change nothing. Unescape `&lt; &gt; &amp;` and Slack
  links before use. Messages from non-operators are dropped silently.
- What was said while flowd was down is not replayed.

**A reply in a run's thread** (an operator, a thread whose permalink is some open run's
`slack_bot_thread`):
1. The run's current entry waits for `slack.reply` → a run-scoped `slack.reply` event
   `{text, user, ts}` wakes it.
2. Otherwise → `run.say` with `from: "<@U…> in Slack"`. Reaction 👀 when it was accepted for the
   agent; the run's next `slack.post` swaps every pending 👀 for ✅. Refused (no agent, run
   finished) → ❌ and a one-line reply saying why.

**A mention in a channel**, top level only, becomes a broadcast `slack.mention`
`{channel, user, text, ts, permalink}`; a trigger `{on: slack.mention, with: {channel: obs}}` starts
a run with these as vars, and that message becomes the run's thread. A mention inside a run's thread
is a reply (above); inside any other thread it is ignored.

**Human steps and stops** (from `observe`):
- `flow.step.human` on a run with a thread → a message: the step's summary, buttons **Done** and
  **Not this**, and a reason field. Button values carry `{run, entry, iteration}`.
- A press is checked against the operators and against the run as it is now (same entry, same
  iteration, still open). Done → `entry.report` done; Not this → failed with the reason (required),
  note `via Slack, <@U…>`. A stale press is answered only to the presser (ephemeral).
- `flow.run.needs-human` → the reason and a **Retry** button, checked the same way.
- `flow.step.closed` (whoever closed it) and `flow.run.done` → the message is updated: no buttons,
  one line saying what happened and who did it.

**Slack app** (set up by a workspace admin): Socket Mode on, app token with `connections:write`;
bot scopes `chat:write`, `reactions:write`, `app_mentions:read`, `channels:history`
(`groups:history` for a private channel, which is recommended: everyone in the channel reads what
agents post); events `app_mention`, `message.channels` (`message.groups`); Interactivity on with
no URL.

## Testing

- Engine: `say` (role choice, prefix, `▶` stripped, refusals). Daemon: `ctx.runs`, `ctx.submit`
  (allowed and refused types), `observe` order, `flow.step.human`/`flow.step.closed`, `/api/act`
  and `flow act` from a session.
- The plugin against a fake Slack: a local WebSocket server speaking hello/envelopes/disconnect,
  and an injected `fetch` for the Web API (never a real socket in tests: a stray consumer steals
  events). Cases: ack and dedupe, refresh without a gap, dead link, non-operator dropped, empty
  operator list refuses to start, reply → wake vs say, mention top-level vs in a thread, splitting
  (fences, long lines), first-post race, button checks (stale, wrong iteration, non-operator),
  messages closed on every resolution path, 429 handling.
- By hand, with the user's go: a real app in a private channel.

## Open questions

1. "Not this" reason: a text field in the same message (cheapest; to be checked on a real payload),
   a modal, or "reply in the thread with the reason"?
2. `slack_bot_thread` as the name of the bot's thread var?
3. Should an operator reply also be able to target a role (`@dev …`) in a run with several agents,
   or always the current step's agent?
