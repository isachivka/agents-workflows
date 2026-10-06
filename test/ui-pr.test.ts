import { test } from "node:test";
import assert from "node:assert/strict";

// plain browser JavaScript, no types: loaded by URL so tsc does not ask for declarations
const P: any = await import(new URL("../ui/pr.js", import.meta.url).href);

test("prUrl: the pr var first, else a PR-shaped var, never another link", () => {
  assert.equal(P.prUrl({ pr: "https://github.com/o/r/pull/1", thread: "https://chat.example/x" }), "https://github.com/o/r/pull/1");
  assert.equal(P.prUrl({ thread: "https://chat.example/archives/C1/p2", pull_request: "https://github.com/o/r/pull/9" }), "https://github.com/o/r/pull/9");
  assert.equal(P.prUrl({ mr: "https://gitlab.example/g/p/-/merge_requests/3" }), "https://gitlab.example/g/p/-/merge_requests/3");
  assert.equal(P.prUrl({ thread: "https://chat.example/archives/C1/p2", wave: "61" }), null);
  assert.equal(P.prUrl({}), null);
});
