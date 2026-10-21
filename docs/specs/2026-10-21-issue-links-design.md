# The run's tracker issue as a standard variable, linked in the UI

## Problem

Runs that wrap work in a tracker issue keep its key in `issue` (`AB-123`) because steps use it in
commands, and the UI shows it as plain text: nothing to click. The name is a convention of one
process, not something the UI or agents can rely on.

## Decisions

- Two standard variables, as `pr` and `slack_thread`: `issue`, the key steps use in commands, and
  `issue_url`, its page. The `flow` skill tells agents to set both the moment the work has an issue.
- The UI shows an issue button (labelled with the key, else "Issue") beside the Slack-thread button on
  run cards, the run page and the human step, and links `issue` in the run's details. Without
  `issue_url` it takes the first variable holding a tracker-issue link (`…/browse/AB-123`, Jira's
  shape), never any other link.
- `flow set` hints when an issue link goes under another name, or under `issue`: the key goes in
  `issue`, the link in `issue_url`.
- No tracker URL in flowd's configuration: the agent that finds or creates the issue knows its page.

## Testing

ui-pr: `issueUrl` prefers `issue_url`, falls back to an issue-shaped var, ignores other links.
cli: `flow set issue=<an issue link>` prints the hint.
