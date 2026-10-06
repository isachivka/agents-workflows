---
worth: low
where: ui/app.js Run, Current, Agents
added: 2026-10-06
---
On the run page every action shares one error line at the top (`Run`'s `err`). A refusal from "Step in by hand" or from the Agents panel (respawn, rebind) shows up above the title, possibly a screen away from the button that caused it, while the spec asks for the error above the actions that caused it. Fix: give `Current` and `Agents` their own `useState` error and an `Err` above their action rows, and pass that setter to their `post`/`focus` calls instead of the page-wide one.
