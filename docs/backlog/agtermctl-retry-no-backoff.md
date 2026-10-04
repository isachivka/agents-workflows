---
worth: medium
where: src/daemon.ts flush, spawnFor
added: 2026-10-04
---
A failed `agtermctl` type or spawn is retried on every flush (once a second), three times, with no backoff, so a short agterm hiccup marks a session closed or fails a role. A spawn that timed out (15 s) may have created the session anyway, and the retry creates a second one. Fix: back off between attempts, and before retrying a spawn look for a session with the expected name in `agtermctl tree`.
