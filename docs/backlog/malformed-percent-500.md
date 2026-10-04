---
worth: low
where: src/http.ts
added: 2026-10-04
---
A malformed `%` escape in a path (`/api/runs/%E0`) makes `decodeURIComponent` throw and the server answers 500 instead of 400.
