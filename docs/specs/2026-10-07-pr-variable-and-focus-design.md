# A standard `pr` variable, a PR button on every run card, and focus that reaches macOS

Status: approved 2026-10-07 by the user.

## Problem

1. The terminal buttons (↗, "open the terminal of …") call `agtermctl session select`: the session
   is selected inside agterm, but agterm itself stays behind the browser (or in another Space).
2. A run's PR is reachable from the UI only while a human step waits on it, and the UI guesses it
   as "the first link among the vars" — which can be a chat-thread link. Agents mostly write the
   PR to `vars.pr`, but nothing says they must, and some invent their own names (`pull_request`).

## Decisions

1. **Focus brings agterm forward.** After `session select`, flowd runs `open -a agterm`
   (`FLOWS_AGTERM_APP` overrides the app name or path), so macOS switches to agterm's Space and
   window with the session already selected. One change in `src/agterm.ts` serves every button.
2. **`pr` is the standard variable** for a run's pull request URL. It is already what the `gh`
   plugin reads by default and what a GitHub-triggered run gets.
   - The `flow` skill tells every agent: the moment your work has a PR (you opened it or found
     it), run `flow set pr=<url>`, even if the step does not ask.
   - `flow set` hints when a pull-request URL goes into another name:
     `flow: hint: pull_request looks like a pull request — the standard name is pr (flow set pr=<url>)`.
     The value is still stored.
   - `docs/processes.md` gains "Standard variables" (`pr`).
3. **The UI shows the PR wherever a run is shown.** `prUrl(vars)`: `vars.pr` when it is a URL,
   otherwise the first var whose value looks like a pull request (`…/pull/<n>` or `…/merge_requests/<n>`);
   never any other link. On the Now page (`#/runs`) every waiting and working card has an
   "Open the PR" button when a PR is known, and a finished row links it; the run page keeps its own.

## Testing

Adapter: `focus` runs select then the opener (fake binaries). CLI: the hint for `pull_request=<PR
url>`, none for `pr=` or a non-PR URL. UI: `prUrl` cases (pr var, a fallback PR-shaped var, a
Slack link ignored), checked by a small unit test of the helper.
