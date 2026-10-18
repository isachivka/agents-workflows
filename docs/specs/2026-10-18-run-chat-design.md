# A conversation per run: talking to agents from a messenger

## Problem

When an agent needs the person's decision (a plan to agree, a report to read), it opens an HTML
overlay in its terminal and waits (`flow wait --human`). The person has to be at that Mac, in that
session, to see it and to answer. Notifications and answers should reach the person wherever they
are, and the answer should be free text that goes back to the agent, not a button.

Several runs work at once, so one chat with everything mixed is no good: each run needs its own
place to talk. Telegram (a group with topics), Mattermost (a channel) and Slack (a thread) all have
one, so flows should talk in terms of "the run's conversation" and leave the messenger to an
adapter that can be switched.

## Goals

- An agent writes to its run's conversation: `flow say "text" [--file path]`.
- Whatever the person writes in that conversation reaches the agent of the run's current step.
- flowd itself says there when the run needs the person and when it ends.
- The messenger is an adapter (a plugin); the core knows none of them. One adapter now: Telegram.

## Non-goals

- Mirroring the agent's output into the conversation: only what it sends with `flow say`.
- Buttons, images or voice from the person; text (and a file's caption) only.
- Mattermost and Slack adapters. The interface is shaped by them, but they are written when wanted.
- Serving reports over HTTP (a link instead of a file): a later spec.
- Running flowd elsewhere than this Mac: a later spec.

## Decisions

### The conversation

- A run's conversation is opened at its first message (from the agent or from flowd), not at
  start: a cron run with nothing to say opens nothing. Its address, as the adapter returned it, is
  kept in `RunState.chat`.
- A nested run talks in its top-most parent's conversation: the stack is one piece of work for one
  agent. `flow say` from a child opens the conversation on the root run if needed.
- When the root run ends (`done`, `failed`, `stopped`), flowd posts the outcome (with the reason)
  and the adapter closes the conversation. A run with no conversation opens none to say it ended.
- A `repeat: true` run keeps one conversation across iterations.

### The agent's side

- `flow say TEXT [--file PATH]`, from the agent's session; the run is the one the session is bound
  to (top of the stack), as for `flow done`. `--run ID` for a script or a person, like `flow set`.
  HTTP: `POST /api/say {session | run, text, file?}`. The file is read by flowd from the local
  disk; a missing file is refused before anything is sent.
- No adapter configured: `flow say` fails with `no chat is set up: add a telegram section to
  $FLOWS_HOME/plugins.yaml (docs/plugins.md)`, so a step prompt that relies on it does not fail
  silently.
- `skills/flow/SKILL.md` gets the rule: when the person must decide on something you wrote, send it
  with `flow say --file`, then `flow wait --human`; the answer arrives as a message in the session.

### flowd's own messages

- When the run comes to need the person (`needsYou` turns true: a human step, a `flow wait
  --human`, a run stopped for the person), flowd posts what it waits for (the step's summary or the
  wait's note). This opens the conversation if there is none.
- When the run ends, as above. Nothing else: steps starting and finishing stay in the UI.

### The person's side

A message in a run's conversation, from an allowed user:

- the run's current entry is an agent step (working, or waiting with `flow wait`): flowd types it
  into that role's session as `<name> (<messenger>): <text>`. A busy agent queues it, as if the
  person typed in the terminal. The run at the top of the stack gets it: with a PR run nested in a
  tracker run, the PR step's agent.
- the current entry has no agent (sh, `wait_for`, `wait`, a human step, a queued run): flowd replies
  in the conversation `no agent is on a step now (<entry>: <kind>); write again when one is` and
  drops the message. A human step is closed from the UI or `flow done --human`, not by a message.
- the run has ended or is unknown: flowd replies `run <id> has ended` (the adapter may also refuse
  to accept messages in a closed conversation).
- From anyone else: ignored and logged.

### The adapter: a plugin with `chat`

```ts
export default {
  name: "telegram",
  chat: {
    open(run: { id: string; process: string; title?: string }, ctx): Promise<string>,   // → address
    post(address: string, msg: { text: string; file?: string }, ctx): Promise<void>,
    close(address: string, end: { outcome: "done" | "failed" | "stopped" }, ctx): Promise<void>,
  },
  start(ctx) { /* listen; ctx.message({address, text, from}) for each message */ },
};
```

- `ctx.message({address, text, from})` hands a message to the core; `from` is a display name. The
  adapter checks who may write (its own config): the core trusts what it is given.
- An adapter is active when `plugins.yaml` has its section. Two active is an error shown in
  Settings → Plugins and by `flow check`; then no chat works until one is removed. Switching
  messengers is moving that section. A run's stored address belongs to the adapter that opened it;
  after a switch, old runs open a new conversation (the address is stored with the adapter's name).
- `post` and `open` failures fail the `flow say` that caused them, with the adapter's error; for
  flowd's own messages they are logged and shown in the plugin's status, never failing the run.

### The Telegram adapter

- `plugins/telegram.ts`, built in, on grammY (a new runtime dependency, agreed). Long polling, so
  no inbound port: it works on this Mac as is.
- Config (`plugins.yaml`):
  ```yaml
  telegram:
    token: "123:abc"     # a bot made for flows; one flowd per bot (Telegram allows one poller)
    chat: -1001234567890 # a group with topics on; the bot is an admin with "manage topics"
    users: [111111111]   # Telegram user ids allowed to write to agents
  ```
- `open`: `createForumTopic` named `<process> #<n> · <title>` (cut to Telegram's 128 characters);
  the address is `<chat>/<message_thread_id>`. `post`: `sendMessage` into the topic, plain text
  (no parse mode, so an agent's text never fails to parse), split at 4096 characters; a file goes
  by `sendDocument` with the text as its caption when it fits in 1024, else as a message before
  it. `close`: `closeForumTopic`.
- Messages: from `chat`, with a `message_thread_id`, from a user in `users`; `text` or `caption`.
  Admin rights let the bot see every message without turning off privacy mode. Messages sent while
  flowd was down are delivered at the next start (Telegram keeps them for a day).
- A refusal says what to fix: the bot is not an admin, topics are off, the chat id is wrong.

## Testing

- Core, with a fake chat plugin: `flow say` opens a conversation once and posts; a nested run
  posts into its root's; the end posts the outcome and closes; a run with no conversation opens
  none at its end; `needsYou` posts and opens; an incoming message is typed into the top run's
  agent session; with no agent on the step it is answered and not typed; an ended run is answered;
  two active adapters are reported; `flow say` without an adapter is refused; a missing file is
  refused.
- Telegram adapter, with a fake Bot API (grammY's `client.fetch` option or a local HTTP server):
  topic creation and naming, splitting, a document with its caption, close, a message from an
  allowed user in a topic reaches `ctx.message`, from anyone else does not.
- CLI and HTTP: `flow say` arguments, `/api/say` validation.
