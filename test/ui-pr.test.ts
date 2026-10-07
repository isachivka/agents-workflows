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

test("repoName: the repository from the PR URL, without its owner", () => {
  assert.equal(P.repoName({ pr: "https://github.com/acme/web-app/pull/12" }), "web-app");
  assert.equal(P.repoName({ mr: "https://gitlab.example/g/sub/api/-/merge_requests/3" }), "api");
  assert.equal(P.repoName({ thread: "https://chat.example/x" }), null);
});

test("slackUrl: the slack_thread var first, else a Slack-thread-shaped var", () => {
  assert.equal(P.slackUrl({ slack_thread: "https://acme.slack.com/archives/C1/p2" }), "https://acme.slack.com/archives/C1/p2");
  assert.equal(P.slackUrl({ thread: "https://acme.slack.com/archives/C1/p2?thread_ts=1.2" }), "https://acme.slack.com/archives/C1/p2?thread_ts=1.2");
  assert.equal(P.slackUrl({ pr: "https://github.com/o/r/pull/1" }), null);
});
