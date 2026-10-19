# No reminder to answer the person

Amends [2026-10-19-notify-design.md](2026-10-19-notify-design.md), "The person's message to the agent".

The reminder typed when an agent's turn ended without a `flow say` after a person's message is
dropped. A message is often a go-ahead ("approve"): the talk ends there, and a reminder would make
the agent send an "ok, going on" the person does not want. The message itself still says where an
answer goes — `flow say`, not the terminal — and adds that a go-ahead needs no answer. An agent that
ends a turn without reporting its step is still nudged by flowd's usual reminders.
