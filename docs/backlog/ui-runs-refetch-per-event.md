---
worth: low
where: ui/app.js App, Now; ui/lib.js useData
added: 2026-10-06
---
Every SSE message makes every live `useData` refetch. On the Now page that is two run lists per event (`App` fetches `/api/runs` for the waiting count, `Now` fetches `/api/runs?all=1`), and a busy run emits many events. Harmless on localhost today; it grows with the number of finished runs (up to 200 summaries each time). Fix: let `App` derive the count from the same list `Now` loads (a shared hook or a tiny module-level cache keyed by path), or filter refetches by what the SSE message says changed.
