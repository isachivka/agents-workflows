# Ping: ask the agent to nudge whoever a run waits on

## Problem

Runs sit for days on a review or a merge. The user nudges the reviewers by hand, or opens the
agent's terminal and asks it to. The agent already knows the PR, the thread and who was asked to
review; it only needs to be asked.

## Goals

- A **Ping** button in the UI on a run whose current step waits for an event (a review, a merge,
  CI): the agent gets a line asking it to nudge whoever the run waits on.
- The run does not change: no report, no step state, the wait goes on.

## Non-goals

- A ping text per process or step (`ping:` on an entry), `flow ping` in the CLI, pings on a timer.
  Each can come later on the same input.

## Decisions

- Engine input `{kind: "ping"}`, daemon event `run.ping`, route `POST /api/runs/:id/ping`. The
  engine returns one `deliver` without an entry, like a queue notice, so the line goes through the
  normal outbox (no typing over the user, not mid-turn).
- Who gets it: the current step's agent if it has a session; for a human step that waits (a merge),
  the first role of the process with a session. None: refused, "no agent of <run> has a session to
  send the ping from".
- When: the run is `running` and its current step is `waiting` for an event, not queued for a hold
  and not a pause. Otherwise refused with what the step is doing.
- The line: `▶ flow: the user asks you to ping whoever <run> is waiting on — step <entry> has
  waited <age> for <event>. PR: … Slack thread: … Find who that is …, then end your turn. Do not
  report the step: the flow keeps waiting for <event>.` PR and thread only when set. The `flow` skill
  says what to do with it.
- A ping to a step the agent has not reached yet is safe: the step is not active, so no reminder
  follows the turn end, and `flow done` stays refused as before.

## Testing

Engine: the line, the role choice for agent and human steps, every refusal, the run unchanged.
Daemon: `run.ping` types the line into the bound session. HTTP: the route and a 409.
