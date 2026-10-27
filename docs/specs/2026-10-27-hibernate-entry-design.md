# hibernate on an entry

Amends [2026-10-27-hibernate-design.md](2026-10-27-hibernate-design.md).

A factory wants its agents closed the moment they hand a reel over for review, but not while they wait
seconds for the screen. `hibernate: <duration>` may now sit on an entry too. Where the run is parked, the
current entry's value wins over the process's; an entry's key alone also opts the process in. `0s`
sleeps the role at the first tick (5 s) after its agent's turn ends there. Everything else — idle agents
only, the conversation recorded, the next line resuming it — is as before.

Testing: a process with `hibernate: 0s` only on its review wait keeps the agent for a day on the step
before, keeps it while the turn on the review entry is still active, and sleeps it at the tick after the
turn completes.
