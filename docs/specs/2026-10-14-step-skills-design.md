# Skills a step needs, named in the agent's own line

## Problem

A step prompt says "/deliver to the test environment …" and relies on a project command for the checks. The prompt
reaches the agent as `flow show`'s output, a tool result: the agent reads `/deliver` as text. In a
real run it loaded one skill by itself, skipped the other and improvised the checks that skill
describes. Typed by the person, the same words make Claude load the skills.

## Decisions

- A step declares `skills: [deliver, aqa]` (`plugin:skill` for a plugin's) in its frontmatter.
- flowd puts them at the end of the step line it types (and of the first prompt of a spawn), the
  person's own message: `… — run \`flow show\` for the instructions · skills for this step: <refs>
  (follow them)`.
- Claude: each name's `SKILL.md` or command file is attached as `@<path>`: Claude Code inlines it
  into the message, mechanically and for any number of skills (checked headless with `claude -p` and
  typed into an interactive session: the file arrived without a tool call; the autocomplete popup
  did not swallow the Enter, as text follows the path). Looked up in the role's `cwd`
  (`.claude/skills/<n>/SKILL.md`, `.claude/commands/<n>.md`), then the Claude directory, then for
  `plugin:skill` the install path in `plugins/installed_plugins.json`. Not found: `/name`, which
  Claude loads with its Skill tool when the person writes it.
  A leading `/name` was rejected: it loads one skill only and runs it at once, with the line as its
  arguments.
- Codex: `$name`, which Codex loads itself. Other agents: `/name`.
- `flow show` lists the skills; the UI step editor keeps them.

## Testing

`test/skills.test.ts` (agent by spawn, lookup order, plugin, not found, Codex), defs (parse, errors,
`splitStep`), daemon (typed line for a Claude role, spawn prompt for a Codex role, `flow show`), HTTP
(the editor's save keeps `skills`).

## Revised the same day

The user's call: a skill is invoked as `/name`, nothing else; the `@path` attachment is dropped,
and with it the file lookup. Claude (and agents other than Codex) get `/deliver /aqa` in the line;
Codex keeps `$name`.
