---
worth: low
where: src/plugins.ts arm
added: 2026-10-04
---
A plugin that writes `async watch(w, ctx)` returns a Promise, which the host stores as the stop function. Stopping the watch then throws (caught and logged) and the plugin's poll keeps running; an async throw is not retried either. Fix: await the result when it is a promise, or reject non-function results with a clear error.
