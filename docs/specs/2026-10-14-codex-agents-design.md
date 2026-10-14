# Codex agents

## Problem

flowd spawns and drives Claude Code. Some work suits Codex better, and the user's daily setup pairs
the two. A role should be able to run Codex with the same step lines, skills and reporting.

## What was checked by hand (Codex CLI 0.162, in agterm)

- `codex '<line>'` sends the line as the first prompt once the folder is trusted.
- `$skill` names in a person's message load the skills, several at once, from the project's
  `.agents/skills` and `.codex/skills` too.
- Typed text, a pause, then Enter alone submits, as with Claude.
- agterm's Codex status hook reports `active` then `completed` for a turn, so flowd's turn tracking
  works unchanged in agterm.
- The empty composer puts the caret in column 2 and a draft past it, as Claude's does: the "do not
  type over the user" check works unchanged.
- The folder-trust question: "Trust this folder?" with "1. Trust and continue" selected; the answer
  is kept in `~/.codex/config.toml` as `[projects."<path>"] trust_level = "trusted"`.
- `/clear` exists ("clear the terminal and start a new chat"); `/compact` exists but nothing reports
  its end (no hook, no status change).
- Sessions: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, the id and cwd in `session_meta`, the
  person's turns as `response_item` user messages; `codex [flags] resume <id>` reopens one.

## Decisions

- The agent is told by the spawn command's program (`agentOf`): `codex` is Codex.
- Step lines to Codex end with `· skills for this step: $flow $<skill> … (follow them)`: `$flow`
  always, since Codex does not pick the flow skill up from a `▶ flow:` line by itself.
- Trust: a folder Codex does not list as trusted is watched for the question; flowd presses Enter.
- `do: clear` types `/clear` for both. `do: compact` on a Codex role fails `flow check`.
- A Codex role in a `terminal: zmx` process fails `flow check`: its turns come through agterm.
- Restore session: found in `~/.codex/sessions` (`$CODEX_HOME`), reopened with `<spawn> resume <id>`.
- `flow install` links the `flow` and `flow-author` skills into `~/.codex/skills` when Codex is there.

## Testing

Skills (`$flow` first), defs (compact and zmx refused), transcripts (Codex rollouts), daemon (trust
answered with Enter, a trusted folder left alone, restore with `codex resume`), install (links only
with Codex present).
